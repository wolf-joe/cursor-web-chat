#!/usr/bin/env python3
"""Cursor Agent 会话浏览器。

用法:
  # 列出指定 workspace 下的所有 agent
  python cursor_agents.py /path/to/your-project

  # 列出某个 agent 的所有 turn（对话轮次）
  python cursor_agents.py /path/to/your-project -a agent-<id>

  # 查看某个 turn 的详细统计（事件分布、工具调用、token 用量）
  python cursor_agents.py /path/to/your-project -a agent-<id> -t 1
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone


def find_index_db(workspace: str) -> str:
    """根据 workspace 路径找到对应的 index.db。"""
    sanitized = os.path.abspath(workspace).lstrip("/").replace("/", "-")
    md5 = hashlib.md5(os.path.abspath(workspace).encode()).hexdigest()
    projects_dir = os.path.expanduser("~/.cursor/projects")

    # 优先按 md5 匹配（sanitized 可能有前导 - 差异）
    for d in os.listdir(projects_dir):
        candidate = os.path.join(projects_dir, d, "sdk-agent-store", md5, "index.db")
        if os.path.exists(candidate):
            return candidate

    raise FileNotFoundError(
        f"未找到 workspace '{workspace}' 对应的 agent store。\n"
        f"  sanitized: {sanitized}\n"
        f"  md5: {md5}\n"
        f"  搜索目录: {projects_dir}"
    )


def fmt_time(iso_str: str | None) -> str:
    if not iso_str:
        return "-"
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return iso_str


def fmt_duration(started: str | None, finished: str | None) -> str:
    if not started or not finished:
        return "-"
    try:
        s = datetime.fromisoformat(started.replace("Z", "+00:00"))
        f = datetime.fromisoformat(finished.replace("Z", "+00:00"))
        secs = (f - s).total_seconds()
        if secs < 60:
            return f"{secs:.0f}s"
        return f"{secs / 60:.1f}m"
    except Exception:
        return "-"


def list_agents(workspace: str):
    """列出 workspace 下的所有 agent。"""
    db_path = find_index_db(workspace)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    agents = list(db.execute(
        "SELECT agent_id, name, status, workspace_ref, created_at, updated_at "
        "FROM agents ORDER BY created_at"
    ))
    db.close()

    if not agents:
        print(f"workspace '{workspace}' 下没有 agent。")
        return

    print(f"Workspace: {workspace}")
    print(f"DB: {db_path}")
    print(f"共 {len(agents)} 个 agent:\n")

    for a in agents:
        print(f"  {a['agent_id']}")
        print(f"    名称:   {a['name']}")
        print(f"    状态:   {a['status']}")
        print(f"    创建:   {fmt_time(a['created_at'])}")
        print(f"    更新:   {fmt_time(a['updated_at'])}")
        print()

    print("提示: 用 -a <agent_id> 查看该 agent 的对话轮次。")


def list_turns(workspace: str, agent_id: str):
    """列出某个 agent 的所有 turn。"""
    db_path = find_index_db(workspace)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    runs = list(db.execute(
        "SELECT run_id, turn_number, status, model, result, usage_json, "
        "created_at, started_at, finished_at "
        "FROM runs WHERE agent_id = ? ORDER BY turn_number",
        (agent_id,)
    ))
    db.close()

    if not runs:
        print(f"agent '{agent_id}' 下没有 turn。")
        return

    print(f"Agent: {agent_id}")
    print(f"共 {len(runs)} 轮对话:\n")

    for r in runs:
        usage = json.loads(r["usage_json"]) if r["usage_json"] else {}
        result_preview = (r["result"] or "").strip().split("\n")[0][:80]
        if r["result"] and len(r["result"].strip()) > 80:
            result_preview += "..."

        print(f"  Turn {r['turn_number']}  [{r['status']}]  {fmt_time(r['created_at'])}")
        print(f"    run_id:   {r['run_id']}")
        print(f"    model:    {r['model']}")
        print(f"    耗时:     {fmt_duration(r['started_at'], r['finished_at'])}")
        print(f"    tokens:   in={usage.get('inputTokens', '-')}  out={usage.get('outputTokens', '-')}  "
              f"cache_read={usage.get('cacheReadTokens', '-')}  total={usage.get('totalTokens', '-')}")
        print(f"    回复预览: {result_preview}")
        print()

    print("提示: 用 -t <turn_number> 查看该轮的详细统计。")


def show_turn_stats(workspace: str, agent_id: str, turn: int):
    """查看某轮对话的详细统计。"""
    db_path = find_index_db(workspace)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    run = db.execute(
        "SELECT * FROM runs WHERE agent_id = ? AND turn_number = ?",
        (agent_id, turn)
    ).fetchone()

    if not run:
        print(f"未找到 agent '{agent_id}' 的 turn {turn}。")
        db.close()
        return

    # 基本信息
    usage = json.loads(run["usage_json"]) if run["usage_json"] else {}
    print(f"Agent:  {agent_id}")
    print(f"Turn:   {turn}")
    print(f"Run ID: {run['run_id']}")
    print(f"状态:   {run['status']}")
    print(f"模型:   {run['model']}")
    print(f"创建:   {fmt_time(run['created_at'])}")
    print(f"开始:   {fmt_time(run['started_at'])}")
    print(f"结束:   {fmt_time(run['finished_at'])}")
    print(f"耗时:   {fmt_duration(run['started_at'], run['finished_at'])}")
    print()

    # Token 用量（千分位格式只对数字生效，缺失时显示 "-"）
    def _fmt_tokens(key: str) -> str:
        v = usage.get(key)
        return f"{v:>10,}" if isinstance(v, int) else f"{'-':>10}"

    print("── Token 用量 ──")
    print(f"  输入:       {_fmt_tokens('inputTokens')}")
    print(f"  输出:       {_fmt_tokens('outputTokens')}")
    print(f"  缓存读取:   {_fmt_tokens('cacheReadTokens')}")
    print(f"  缓存写入:   {_fmt_tokens('cacheWriteTokens')}")
    print(f"  总计:       {_fmt_tokens('totalTokens')}")
    print()

    # 事件统计
    events = list(db.execute(
        "SELECT seq, payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
        (run["run_id"],)
    ))
    db.close()

    if not events:
        print("无事件记录。")
        return

    msg_types = Counter()
    tool_calls = []  # (name, status)
    thinking_texts = []
    assistant_chunks = 0

    for ev in events:
        if not ev["payload_json"]:
            continue
        d = json.loads(ev["payload_json"])
        msg = d.get("message", {})
        mt = msg.get("type", "unknown")
        msg_types[mt] += 1

        if mt == "tool_call":
            tool_calls.append((msg.get("name", "?"), msg.get("status", "?")))
        elif mt == "thinking":
            text = msg.get("text", "")
            if text.strip():
                thinking_texts.append(text)
        elif mt == "assistant":
            assistant_chunks += 1

    # 事件分布
    print("── 事件分布 ──")
    for mt, count in msg_types.most_common():
        print(f"  {mt:20s}  {count:>6}")
    print(f"  {'总计':20s}  {len(events):>6}")
    print()

    # 工具调用
    if tool_calls:
        tool_counter = Counter(name for name, _ in tool_calls)
        print("── 工具调用 ──")
        for name, count in tool_counter.most_common():
            # 统计每个工具的 running/completed
            statuses = [s for n, s in tool_calls if n == name]
            completed = statuses.count("completed")
            print(f"  {name:20s}  调用 {count} 次 (completed={completed})")
        print()

    # 思考过程摘要
    if thinking_texts:
        print("── 思考过程 ──")
        full_thinking = "".join(thinking_texts)
        # 按句/行截断展示前 300 字
        preview = full_thinking.strip()[:300]
        if len(full_thinking.strip()) > 300:
            preview += "..."
        print(f"  {preview}")
        print()

    # 回复摘要
    if run["result"]:
        print("── 回复内容 (前 500 字) ──")
        print(run["result"].strip()[:500])
        if len(run["result"].strip()) > 500:
            print("...")


def main():
    parser = argparse.ArgumentParser(
        description="Cursor Agent 会话浏览器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s /path/to/your-project
  %(prog)s /path/to/your-project -a agent-<id>
  %(prog)s /path/to/your-project -a agent-<id> -t 1
        """,
    )
    parser.add_argument("workspace", help="workspace 路径（项目根目录）")
    parser.add_argument("-a", "--agent", help="agent ID，查看该 agent 的对话轮次")
    parser.add_argument("-t", "--turn", type=int, help="turn 编号，查看该轮的详细统计")

    args = parser.parse_args()

    if args.turn is not None and not args.agent:
        parser.error("使用 -t 时必须同时指定 -a")

    if not args.agent:
        list_agents(args.workspace)
    elif args.turn is None:
        list_turns(args.workspace, args.agent)
    else:
        show_turn_stats(args.workspace, args.agent, args.turn)


if __name__ == "__main__":
    main()
