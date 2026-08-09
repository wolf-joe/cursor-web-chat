#!/usr/bin/env python3
"""Cursor Agent 对话历史 Web 浏览器。

移动端友好的单页应用，用抽屉按 workspace 分组展示 agent，
点击 agent 查看完整对话历史。

用法:
  python cursor_agent_viewer.py [--port 5000] [--host 0.0.0.0]
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from functools import lru_cache
from pathlib import Path

from flask import Flask, jsonify, request

app = Flask(__name__)

PROJECTS_DIR = Path.home() / ".cursor" / "projects"
ACP_DIR = Path.home() / ".cursor" / "acp-sessions"
CHATS_DIR = Path.home() / ".cursor" / "chats"
SKIP_DIRS = {"canvases", "mcps"}

# 用户消息缓存: agent_id -> {timestamp, messages}
_USER_MSG_CACHE: dict[str, dict] = {}
_CACHE_TTL = 300  # 5分钟


# ── 路径反推 ──

def _md5(path: str) -> str:
    return hashlib.md5(path.encode()).hexdigest()


def _from_indexdb(proj_dir: Path) -> str | None:
    store = proj_dir / "sdk-agent-store"
    if not store.is_dir():
        return None
    for hd in store.iterdir():
        db = hd / "index.db"
        if not db.exists():
            continue
        try:
            conn = sqlite3.connect(str(db))
            row = conn.execute("SELECT DISTINCT workspace_ref FROM agents LIMIT 1").fetchone()
            conn.close()
            if row and row[0]:
                return row[0]
        except Exception:
            pass
    return None


def _from_worker_log(proj_dir: Path) -> str | None:
    log = proj_dir / "worker.log"
    if not log.exists():
        return None
    try:
        with open(log, errors="replace") as f:
            for line in f:
                m = re.search(r"workspacePath=(\S+)", line)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return None


def _from_sanitized_guess(proj_dir: Path) -> tuple[str, bool]:
    name = proj_dir.name
    parts = name.split("-")
    n = len(parts)
    for mask in range(1 << (n - 1)):
        segs = [parts[0]]
        for i in range(1, n):
            if mask & (1 << (i - 1)):
                segs[-1] += "/" + parts[i]
            else:
                segs[-1] += "-" + parts[i]
        path = "/" + "/".join(segs)
        if os.path.exists(path):
            return path, True
    return "/" + name.replace("-", "/"), False


def resolve_workspace(proj_dir: Path) -> str:
    for resolver in (_from_indexdb, _from_worker_log):
        r = resolver(proj_dir)
        if r:
            return r
    guess, _ = _from_sanitized_guess(proj_dir)
    return guess


# ── 数据收集 ──

def collect_all() -> list[dict]:
    """收集所有 workspace 及其 agent。"""
    results = []
    for d in sorted(PROJECTS_DIR.iterdir()):
        if not d.is_dir() or d.name in SKIP_DIRS or d.name.startswith("tmp-"):
            continue
        has_sdk = (d / "sdk-agent-store").is_dir()
        has_transcripts = (d / "agent-transcripts").is_dir()
        if not has_sdk and not has_transcripts:
            continue

        workspace = resolve_workspace(d)
        agents = []

        # SDK agents (from index.db)
        if has_sdk:
            for hd in (d / "sdk-agent-store").iterdir():
                db = hd / "index.db"
                if not db.exists():
                    continue
                try:
                    conn = sqlite3.connect(str(db))
                    conn.row_factory = sqlite3.Row
                    for row in conn.execute(
                        "SELECT agent_id, name, status, created_at, updated_at FROM agents"
                    ):
                        # 统计 turns
                        turns = list(conn.execute(
                            "SELECT run_id, turn_number, status, model, created_at, "
                            "started_at, finished_at, usage_json, result "
                            "FROM runs WHERE agent_id = ? ORDER BY turn_number",
                            (row["agent_id"],)
                        ))
                        agent = {
                            "agent_id": row["agent_id"],
                            "name": row["name"],
                            "status": row["status"],
                            "created_at": row["created_at"],
                            "updated_at": row["updated_at"],
                            "source": "sdk",
                            "turns": [],
                            "transcript_path": None,
                        }
                        for t in turns:
                            usage = json.loads(t["usage_json"]) if t["usage_json"] else {}
                            agent["turns"].append({
                                "turn": t["turn_number"],
                                "run_id": t["run_id"],
                                "status": t["status"],
                                "model": t["model"],
                                "created_at": t["created_at"],
                                "duration": _duration(t["started_at"], t["finished_at"]),
                                "tokens": {
                                    "in": usage.get("inputTokens", 0),
                                    "out": usage.get("outputTokens", 0),
                                    "total": usage.get("totalTokens", 0),
                                },
                                "result_preview": (t["result"] or "")[:200],
                            })
                        agents.append(agent)
                    conn.close()
                except Exception:
                    pass

        # IDE transcripts
        if has_transcripts:
            transcripts_dir = d / "agent-transcripts"
            for td in transcripts_dir.iterdir():
                jsonl_files = list(td.glob("*.jsonl"))
                if not jsonl_files:
                    continue
                jsonl_path = jsonl_files[0]
                session_id = td.name
                # 避免和 SDK agent 重复（SDK agent 的 transcript 目录名 = agent_id）
                if any(a["agent_id"] == session_id for a in agents):
                    continue
                # 读第一条 user 消息作为标题
                title = "IDE Agent"
                turn_count = 0
                try:
                    with open(jsonl_path, errors="replace") as f:
                        for line in f:
                            d2 = json.loads(line.strip())
                            if d2.get("role") == "user":
                                turn_count += 1
                                if turn_count == 1:
                                    msg = d2.get("message", {})
                                    content = msg.get("content", [])
                                    if isinstance(content, list):
                                        for c in content:
                                            if c.get("type") == "text":
                                                title = _extract_query(c.get("text", ""))[:60]
                                                break
                except Exception:
                    pass
                mtime = jsonl_path.stat().st_mtime
                mtime_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime))
                agents.append({
                    "agent_id": session_id,
                    "name": title,
                    "status": "N/A",
                    "created_at": mtime_iso,
                    "updated_at": mtime_iso,
                    "source": "ide",
                    "turns": [],
                    "transcript_path": str(jsonl_path),
                    "turn_count": turn_count,
                })

        # 决策·newest-first: 文件夹内会话按最近活动时间倒序，最新在上。
        agents.sort(key=lambda a: a.get("updated_at") or a.get("created_at") or "", reverse=True)

        results.append({
            "workspace": workspace,
            "dir_name": d.name,
            "agent_count": len(agents),
            "agents": agents,
        })
    return results


def _duration(started: str | None, finished: str | None) -> str:
    if not started or not finished:
        return "-"
    try:
        from datetime import datetime
        s = datetime.fromisoformat(started.replace("Z", "+00:00"))
        f = datetime.fromisoformat(finished.replace("Z", "+00:00"))
        secs = (f - s).total_seconds()
        if secs < 60:
            return f"{secs:.0f}s"
        return f"{secs / 60:.1f}m"
    except Exception:
        return "-"


def _extract_query(text: str) -> str:
    """从 user 消息文本中提取实际 query（去掉 <timestamp> / <user_query> 标签）。"""
    m = re.search(r"<user_query>\s*(.*?)\s*</user_query>", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return text.strip()


# ── API ──

@app.route("/api/workspaces")
def api_workspaces():
    return jsonify(collect_all())


@app.route("/api/agent/<path:agent_id>")
def api_agent_detail(agent_id: str):
    """获取某个 agent 的对话历史。

    SDK agent: 从 run_events 表读取事件流，重建对话
    IDE agent: 直接读 transcript jsonl
    """
    # 先找到这个 agent 属于哪个 project
    for d in PROJECTS_DIR.iterdir():
        if not d.is_dir() or d.name in SKIP_DIRS or d.name.startswith("tmp-"):
            continue

        # 尝试 SDK agent store
        store = d / "sdk-agent-store"
        if store.is_dir():
            for hd in store.iterdir():
                db = hd / "index.db"
                if not db.exists():
                    continue
                conn = sqlite3.connect(str(db))
                conn.row_factory = sqlite3.Row
                agent_row = conn.execute(
                    "SELECT * FROM agents WHERE agent_id = ?", (agent_id,)
                ).fetchone()
                if agent_row:
                    runs = list(conn.execute(
                        "SELECT * FROM runs WHERE agent_id = ? ORDER BY turn_number",
                        (agent_id,)
                    ))
                    turns = []
                    for r in runs:
                        events = list(conn.execute(
                            "SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
                            (r["run_id"],)
                        ))
                        messages = _reconstruct_messages(events)
                        usage = json.loads(r["usage_json"]) if r["usage_json"] else {}
                        turns.append({
                            "turn": r["turn_number"],
                            "run_id": r["run_id"],
                            "status": r["status"],
                            "model": r["model"],
                            "created_at": r["created_at"],
                            "duration": _duration(r["started_at"], r["finished_at"]),
                            "tokens": {
                                "in": usage.get("inputTokens", 0),
                                "out": usage.get("outputTokens", 0),
                                "total": usage.get("totalTokens", 0),
                            },
                            "messages": messages,
                        })
                    conn.close()

                    # 获取用户消息并插入到每个 turn 的开头
                    workspace = resolve_workspace(d)
                    try:
                        user_msgs = _get_user_messages_sdk(agent_id, workspace)
                    except Exception as e:
                        return jsonify({
                            "error": f"获取 User message 失败: {e}",
                        }), 500
                    for turn in turns:
                        user_text = user_msgs.get(turn["turn"] - 1, "")
                        if user_text:
                            turn["messages"].insert(0, {
                                "role": "user",
                                "blocks": [{"type": "text", "text": user_text}]
                            })

                    return jsonify({
                        "agent_id": agent_id,
                        "name": agent_row["name"],
                        "source": "sdk",
                        "workspace": workspace,
                        "turns": turns,
                    })
                conn.close()

        # 尝试 IDE transcript
        transcripts_dir = d / "agent-transcripts"
        if transcripts_dir.is_dir():
            td = transcripts_dir / agent_id
            jsonl_path = td / f"{agent_id}.jsonl"
            if jsonl_path.exists():
                messages = []
                try:
                    with open(jsonl_path, errors="replace") as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            d2 = json.loads(line)
                            role = d2.get("role", "unknown")
                            msg = d2.get("message", {})
                            content = msg.get("content", [])
                            blocks = []
                            if isinstance(content, list):
                                for c in content:
                                    blocks.append({
                                        "type": c.get("type", "text"),
                                        "text": c.get("text", ""),
                                        "tool_name": c.get("name", ""),
                                        "tool_input": c.get("input", {}),
                                    })
                            elif isinstance(content, str):
                                blocks.append({"type": "text", "text": content})
                            messages.append({"role": role, "blocks": blocks})
                except Exception:
                    pass
                return jsonify({
                    "agent_id": agent_id,
                    "name": agent_id,
                    "source": "ide",
                    "workspace": resolve_workspace(d),
                    "turns": [{"turn": 1, "messages": messages}],
                })

    return jsonify({"error": "Agent not found"}), 404


def _reconstruct_messages(events: list) -> list[dict]:
    """从 run_events 重建对话消息列表。"""
    messages = []
    current_assistant_text = ""
    current_thinking = ""
    current_tools = []

    for ev in events:
        if not ev["payload_json"]:
            continue
        d = json.loads(ev["payload_json"])
        msg = d.get("message", {})
        mt = msg.get("type")

        if mt == "thinking":
            text = msg.get("text", "")
            if text.strip():
                current_thinking += text
        elif mt == "assistant":
            content = msg.get("message", {}).get("content", [])
            for c in content:
                if c.get("type") == "text":
                    current_assistant_text += c.get("text", "")
        elif mt == "tool_call":
            if msg.get("status") == "completed":
                current_tools.append({
                    "name": msg.get("name", ""),
                    "args": msg.get("args", {}),
                    "result": msg.get("result", {}),
                })
        elif mt == "usage":
            # 结束一个 turn 的 assistant 输出
            pass
        elif mt == "status" and msg.get("status") == "FINISHED":
            if current_assistant_text or current_thinking or current_tools:
                messages.append({
                    "role": "assistant",
                    "blocks": _build_blocks(current_assistant_text, current_thinking, current_tools),
                })
                current_assistant_text = ""
                current_thinking = ""
                current_tools = []

    # 兜底：如果最后还有未 flush 的内容
    if current_assistant_text or current_thinking or current_tools:
        messages.append({
            "role": "assistant",
            "blocks": _build_blocks(current_assistant_text, current_thinking, current_tools),
        })

    return messages


def _build_blocks(text: str, thinking: str, tools: list) -> list[dict]:
    blocks = []
    if thinking.strip():
        blocks.append({"type": "thinking", "text": thinking.strip()})
    if tools:
        for t in tools:
            blocks.append({
                "type": "tool_call",
                "tool_name": t["name"],
                "tool_input": t["args"],
                "tool_result": t["result"],
            })
    if text.strip():
        blocks.append({"type": "text", "text": text.strip()})
    return blocks


def _get_user_messages_sdk(agent_id: str, workspace: str) -> dict[int, str]:
    """通过 SDK 获取 agent 的用户消息。

    返回: {turn_index: user_text}
    依赖缺失或 SDK 调用失败时直接抛错，由 API 层返回给前端展示。
    """
    # 检查缓存
    now = time.time()
    cache_key = f"{agent_id}@{workspace}"
    if cache_key in _USER_MSG_CACHE:
        cached = _USER_MSG_CACHE[cache_key]
        if now - cached["timestamp"] < _CACHE_TTL:
            return cached["messages"]

    try:
        from cursor_sdk import Agent, CursorClient
    except ImportError as e:
        raise RuntimeError(
            "缺少 Python 依赖 cursor_sdk，无法读取 User message。"
            "请安装 cursor_sdk 后再打开 SDK 会话。"
        ) from e

    with CursorClient.launch_bridge(workspace=workspace) as client:
        agent = client.resume_agent(agent_id)
        msgs = agent.list_messages()
        result = {}
        for m in msgs:
            if m.type == "user" and m.message:
                turn_data = m.message.get("turn", {})
                if turn_data.get("case") == "agentConversationTurn":
                    user_msg = turn_data.get("value", {}).get("userMessage", {})
                    text = user_msg.get("text", "")
                    # uuid 格式: agent-id:turn_index
                    uuid = m.uuid
                    if ":" in uuid:
                        turn_idx = int(uuid.split(":")[-1])
                        result[turn_idx] = text

    # 更新缓存
    _USER_MSG_CACHE[cache_key] = {"timestamp": now, "messages": result}
    return result


# ── API ──

HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Cursor Agent Viewer</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
  --border: #30363d; --text: #e6edf3; --text2: #8b949e;
  --accent: #58a6ff; --green: #3fb950; --orange: #d29922; --red: #f85149;
  --purple: #bc8cff;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.6; }

/* 抽屉 */
.drawer { position: fixed; top: 0; left: 0; width: 300px; height: 100vh; background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; z-index: 100; transform: translateX(-100%); transition: transform 0.25s ease; }
.drawer.open { transform: translateX(0); }
.drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 99; opacity: 0; pointer-events: none; transition: opacity 0.25s; }
.drawer-backdrop.open { opacity: 1; pointer-events: auto; }

/* 顶栏 */
.topbar { position: sticky; top: 0; background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 16px; display: flex; align-items: center; gap: 12px; z-index: 50; }
.topbar .menu-btn { background: none; border: none; color: var(--text); font-size: 20px; cursor: pointer; padding: 4px; }
.topbar .title { flex: 1; font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 抽屉内容 */
.drawer-header { padding: 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 13px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }
.ws-group { border-bottom: 1px solid var(--border); }
.ws-group-header { padding: 10px 16px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ws-group-header:hover { background: var(--surface2); }
.ws-group-header .arrow { transition: transform 0.2s; font-size: 10px; color: var(--text2); }
.ws-group-header .arrow.open { transform: rotate(90deg); }
.ws-group-header .ws-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-group-header .badge { background: var(--surface2); color: var(--text2); border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.ws-agents { display: none; }
.ws-agents.open { display: block; }
.agent-item { padding: 8px 16px 8px 32px; cursor: pointer; font-size: 13px; color: var(--text2); border-left: 2px solid transparent; }
.agent-item:hover { background: var(--surface2); color: var(--text); }
.agent-item.active { border-left-color: var(--accent); color: var(--accent); background: var(--surface2); }
.agent-item .agent-source { font-size: 10px; color: var(--orange); margin-left: 6px; }
.agent-item .agent-source.sdk { color: var(--green); }

/* 主内容 */
.main { padding: 16px; max-width: 800px; margin: 0 auto; }
.turn-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
.turn-header { padding: 8px 12px; background: var(--surface2); display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text2); flex-wrap: wrap; }
.turn-header .turn-num { color: var(--accent); font-weight: 600; }
.turn-header .tag { padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.turn-header .tag.model { background: var(--surface); color: var(--purple); }
.turn-header .tag.duration { background: var(--surface); color: var(--orange); }
.turn-header .tag.tokens { background: var(--surface); color: var(--green); }

.msg { padding: 12px; border-bottom: 1px solid var(--border); }
.msg:last-child { border-bottom: none; }
.msg.user { background: rgba(88, 166, 255, 0.05); }
.msg.assistant { background: var(--surface); }
.msg-role { font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 6px; }
.msg.user .msg-role { color: var(--accent); }
.msg.assistant .msg-role { color: var(--green); }

.block { margin-bottom: 8px; }
.block:last-child { margin-bottom: 0; }
.block-thinking { color: var(--text2); font-style: italic; padding: 8px; background: rgba(188, 140, 255, 0.08); border-radius: 4px; border-left: 3px solid var(--purple); font-size: 13px; }
.block-tool { padding: 8px; background: var(--bg); border-radius: 4px; border: 1px solid var(--border); font-size: 13px; }
.block-tool .tool-header { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.block-tool .tool-name { color: var(--orange); font-weight: 600; }
.block-tool .tool-summary { color: var(--text2); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.block-tool .tool-toggle { color: var(--text2); font-size: 11px; background: var(--surface2); border: 1px solid var(--border); border-radius: 3px; padding: 1px 6px; cursor: pointer; }
.block-tool .tool-toggle:hover { color: var(--accent); border-color: var(--accent); }
.block-tool .tool-detail { display: none; margin-top: 6px; }
.block-tool .tool-detail.open { display: block; }
.block-tool .tool-section-label { font-size: 10px; color: var(--text2); text-transform: uppercase; margin-bottom: 2px; margin-top: 6px; }
.block-tool .tool-json { color: var(--text2); font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; padding: 6px; background: var(--surface); border-radius: 4px; border: 1px solid var(--border); }
.block-text { white-space: pre-wrap; word-break: break-word; }
.block-text code { background: var(--bg); padding: 1px 4px; border-radius: 3px; font-size: 13px; }
.block-text pre { background: var(--bg); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
.block-text pre code { background: none; padding: 0; }
.block-text table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
.block-text th, .block-text td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.block-text th { background: var(--surface2); font-weight: 600; }
.block-text tr:nth-child(even) { background: rgba(255,255,255,0.02); }
.block-text ul, .block-text ol { margin: 4px 0 4px 20px; }
.block-text li { margin: 2px 0; }
.block-text blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--text2); margin: 8px 0; }
.block-text hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }

/* loading / empty */
.loading { text-align: center; padding: 40px; color: var(--text2); }
.empty { text-align: center; padding: 40px; color: var(--text2); }
.spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<div class="topbar">
  <button class="menu-btn" onclick="toggleDrawer()">&#9776;</button>
  <span class="title" id="pageTitle">Cursor Agent Viewer</span>
</div>

<div class="drawer-backdrop" id="backdrop" onclick="toggleDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-header">Workspaces</div>
  <div id="drawerContent"></div>
</div>

<div class="main" id="main">
  <div class="empty">点击左上角菜单选择 Agent</div>
</div>

<script>
let currentAgent = null;

async function loadWorkspaces() {
  const res = await fetch('/api/workspaces');
  const data = await res.json();
  const container = document.getElementById('drawerContent');
  container.innerHTML = '';
  for (const ws of data) {
    const group = document.createElement('div');
    group.className = 'ws-group';
    const shortName = ws.workspace.split('/').slice(-2).join('/');
    group.innerHTML = `
      <div class="ws-group-header" onclick="toggleGroup(this)">
        <span class="arrow">&#9654;</span>
        <span class="ws-name" title="${ws.workspace}">${shortName}</span>
        <span class="badge">${ws.agent_count}</span>
      </div>
      <div class="ws-agents"></div>
    `;
    const agentsDiv = group.querySelector('.ws-agents');
    for (const agent of ws.agents) {
      const item = document.createElement('div');
      item.className = 'agent-item';
      const srcLabel = agent.source === 'sdk' ? '<span class="agent-source sdk">SDK</span>' : '<span class="agent-source">IDE</span>';
      const turnInfo = agent.turns.length ? `(${agent.turns.length}t)` : (agent.turn_count ? `(${agent.turn_count}t)` : '');
      item.innerHTML = `${agent.name} ${srcLabel} <span style="font-size:11px;color:var(--text2)">${turnInfo}</span>`;
      item.onclick = () => selectAgent(agent.agent_id, agent.name, item);
      agentsDiv.appendChild(item);
    }
    container.appendChild(group);
  }
}

function toggleGroup(header) {
  const agents = header.nextElementSibling;
  const arrow = header.querySelector('.arrow');
  agents.classList.toggle('open');
  arrow.classList.toggle('open');
}

function toggleDrawer() {
  document.getElementById('drawer').classList.toggle('open');
  document.getElementById('backdrop').classList.toggle('open');
}

async function selectAgent(agentId, name, item) {
  // 高亮选中
  document.querySelectorAll('.agent-item').forEach(e => e.classList.remove('active'));
  item.classList.add('active');
  document.getElementById('pageTitle').textContent = name;
  toggleDrawer();

  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  const res = await fetch(`/api/agent/${agentId}`);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    main.innerHTML = `<div class="empty">请求失败 (HTTP ${res.status})</div>`;
    return;
  }
  if (!res.ok || data.error) {
    main.innerHTML = `<div class="empty">${escapeHtml(data.error || `请求失败 (HTTP ${res.status})`)}</div>`;
    return;
  }
  currentAgent = data;
  renderAgent(data);
}

function renderAgent(data) {
  const main = document.getElementById('main');
  let html = `<div style="margin-bottom:12px;color:var(--text2);font-size:12px;">${data.workspace} &middot; ${data.source.toUpperCase()}</div>`;

  for (const turn of data.turns) {
    html += `<div class="turn-card">`;
    html += `<div class="turn-header">`;
    html += `<span class="turn-num">Turn ${turn.turn}</span>`;
    if (turn.model) html += `<span class="tag model">${turn.model}</span>`;
    if (turn.duration && turn.duration !== '-') html += `<span class="tag duration">${turn.duration}</span>`;
    if (turn.tokens && turn.tokens.total) html += `<span class="tag tokens">${turn.tokens.total.toLocaleString()} tok</span>`;
    if (turn.status) html += `<span style="color:var(--${turn.status === 'FINISHED' || turn.status === 'finished' ? 'green' : 'orange'})">${turn.status}</span>`;
    html += `</div>`;

    for (const msg of turn.messages) {
      html += `<div class="msg ${msg.role}">`;
      html += `<div class="msg-role">${msg.role}</div>`;
      for (const block of msg.blocks) {
        if (block.type === 'thinking') {
          html += `<div class="block block-thinking">${escapeHtml(block.text)}</div>`;
        } else if (block.type === 'tool_call') {
          const argStr = block.tool_input && Object.keys(block.tool_input).length ? JSON.stringify(block.tool_input, null, 2) : '';
          const resultStr = block.tool_result ? (typeof block.tool_result === 'string' ? block.tool_result : JSON.stringify(block.tool_result, null, 2)) : '';
          const summary = argStr ? Object.entries(block.tool_input).map(([k,v]) => `${k}=${typeof v === 'string' ? v.substring(0,40) : JSON.stringify(v).substring(0,40)}`).join(', ') : '';
          const toolId = 'tool-' + Math.random().toString(36).slice(2,9);
          html += `<div class="block block-tool">`;
          html += `<div class="tool-header" onclick="toggleTool('${toolId}')">`;
          html += `<span class="tool-name">${escapeHtml(block.tool_name)}</span>`;
          html += `<span class="tool-summary">${escapeHtml(summary)}</span>`;
          html += `<span class="tool-toggle" id="${toolId}-btn" onclick="event.stopPropagation(); toggleTool('${toolId}')">展开</span>`;
          html += `</div>`;
          html += `<div class="tool-detail" id="${toolId}">`;
          if (argStr) {
            html += `<div class="tool-section-label">Input</div>`;
            html += `<div class="tool-json">${escapeHtml(argStr)}</div>`;
          }
          if (resultStr) {
            html += `<div class="tool-section-label">Result</div>`;
            html += `<div class="tool-json">${escapeHtml(resultStr)}</div>`;
          }
          html += `</div>`;
          html += `</div>`;
        } else if (block.type === 'text') {
          html += `<div class="block block-text">${renderMarkdown(block.text)}</div>`;
        }
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  if (!data.turns.length || (data.turns.length === 1 && !data.turns[0].messages.length)) {
    html += '<div class="empty">无对话记录</div>';
  }

  main.innerHTML = html;
}

function toggleTool(toolId) {
  const detail = document.getElementById(toolId);
  const btn = document.getElementById(toolId + '-btn');
  if (detail.classList.contains('open')) {
    detail.classList.remove('open');
    btn.textContent = '展开';
  } else {
    detail.classList.add('open');
    btn.textContent = '折叠';
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    return marked.parse(text);
  }
  // fallback: escape only
  return escapeHtml(text);
}

loadWorkspaces();
</script>
</body>
</html>"""


@app.route("/")
def index():
    return HTML


def main():
    parser = argparse.ArgumentParser(description="Cursor Agent 对话历史 Web 浏览器")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址 (默认 0.0.0.0)")
    parser.add_argument("--port", type=int, default=5000, help="监听端口 (默认 5000)")
    args = parser.parse_args()

    print(f"启动 Cursor Agent Viewer: http://localhost:{args.port}")
    app.run(host=args.host, port=args.port, debug=True)


if __name__ == "__main__":
    main()
