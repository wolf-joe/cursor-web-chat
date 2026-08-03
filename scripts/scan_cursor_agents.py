#!/usr/bin/env python3
"""扫描 ~/.cursor/projects/，反推哪些文件夹用过 Cursor Agent。

路径反推的可靠信息源（按优先级）：
1. index.db 的 agents.workspace_ref（SDK agent，精确）
2. acp-sessions/*/meta.json 的 cwd（精确）
3. worker.log 里的 workspacePath=（精确）
4. chats/*/store.db blob 里的 "Workspace Path:"（IDE agent）
5. 目录名 sanitized 反推（fallback，连字符歧义）
"""
import hashlib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path


PROJECTS_DIR = Path.home() / ".cursor" / "projects"
ACP_DIR = Path.home() / ".cursor" / "acp-sessions"
CHATS_DIR = Path.home() / ".cursor" / "chats"

SKIP_DIRS = {"canvases", "mcps"}


def md5_of(path: str) -> str:
    return hashlib.md5(path.encode()).hexdigest()


def from_sdk_indexdb(proj_dir: Path) -> str | None:
    """从 index.db 的 agents.workspace_ref 获取原始路径。"""
    store = proj_dir / "sdk-agent-store"
    if not store.is_dir():
        return None
    for hash_dir in store.iterdir():
        db_path = hash_dir / "index.db"
        if not db_path.exists():
            continue
        try:
            conn = sqlite3.connect(str(db_path))
            row = conn.execute("SELECT DISTINCT workspace_ref FROM agents LIMIT 1").fetchone()
            conn.close()
            if row and row[0]:
                return row[0]
        except Exception:
            pass
    return None


def from_worker_log(proj_dir: Path) -> str | None:
    """从 worker.log 提取 workspacePath=。"""
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


def from_acp_sessions(proj_dir: Path) -> str | None:
    """从 acp-sessions 的 meta.json 反查（需要匹配 md5 hash）。"""
    # acp-sessions 的 meta.json 里有 cwd，但目录名是 session uuid 不是 hash
    # 需要 md5(cwd) 匹配 proj_dir 下的 sdk-agent-store hash 子目录
    store = proj_dir / "sdk-agent-store"
    if not store.is_dir():
        return None
    hash_dirs = [d.name for d in store.iterdir() if d.is_dir()]
    if not hash_dirs or not ACP_DIR.is_dir():
        return None

    for session_dir in ACP_DIR.iterdir():
        meta = session_dir / "meta.json"
        if not meta.exists():
            continue
        try:
            data = json.loads(meta.read_text())
            cwd = data.get("cwd", "")
            if cwd and md5_of(cwd) in hash_dirs:
                return cwd
        except Exception:
            pass
    return None


def from_chats_storedb(proj_dir: Path) -> str | None:
    """从 chats/*/store.db 的 blob 里搜 'Workspace Path:'。"""
    if not CHATS_DIR.is_dir():
        return None
    # 找到对应的 hash 目录
    for hash_dir in CHATS_DIR.iterdir():
        for session_dir in hash_dir.iterdir():
            db_path = session_dir / "store.db"
            if not db_path.exists():
                continue
            try:
                conn = sqlite3.connect(str(db_path))
                for row in conn.execute("SELECT data FROM blobs"):
                    text = row[0].decode("utf-8", errors="replace")
                    m = re.search(r"Workspace Path: (\S+)", text)
                    if m:
                        path = m.group(1)
                        # 验证 md5 是否匹配 proj_dir 名称
                        if md5_of(path) == hash_dir.name:
                            conn.close()
                            return path
                conn.close()
            except Exception:
                pass
    return None


def from_sanitized_guess(proj_dir: Path) -> tuple[str | None, bool]:
    """从目录名反推（有连字符歧义）。

    策略：尝试所有可能的 - 分割方式，返回第一个存在的路径。
    例如 home-worker-git-rashomon-nexus 可能是:
      /path/to/monorepo/pkg-a (正确)
      /path/to/wrong/sibling
      /home-worker/git/rashomon-nexus
      ... 等
    """
    name = proj_dir.name
    parts = name.split("-")
    n = len(parts)

    # 生成所有可能的分割方式（将 - 重新组合为目录分隔符或保留为连字符）
    # 用位掩码：bit=1 表示该位置的 - 是路径分隔符，bit=0 表示保留为连字符
    for mask in range(1 << (n - 1)):
        segments = [parts[0]]
        for i in range(1, n):
            if mask & (1 << (i - 1)):
                segments[-1] += "/" + parts[i]
            else:
                segments[-1] += "-" + parts[i]
        path = "/" + "/".join(segments)
        if os.path.exists(path):
            return path, True

    # 都不存在，返回最可能的推测（完全替换）
    return "/" + name.replace("-", "/"), False


def resolve_workspace(proj_dir: Path) -> tuple[str, bool, str]:
    """返回 (workspace路径, 是否精确, 来源)。"""
    # 按优先级尝试各信息源
    for source, resolver in [
        ("index.db", from_sdk_indexdb),
        ("worker.log", from_worker_log),
        ("acp-sessions", from_acp_sessions),
        ("chats/store.db", from_chats_storedb),
    ]:
        result = resolver(proj_dir)
        if result:
            return result, True, source

    # fallback: 目录名反推
    guess, verified = from_sanitized_guess(proj_dir)
    return guess, verified, "目录名推测"


def main():
    if not PROJECTS_DIR.is_dir():
        print(f"目录不存在: {PROJECTS_DIR}")
        sys.exit(1)

    rows = []
    for d in sorted(PROJECTS_DIR.iterdir()):
        if not d.is_dir() or d.name in SKIP_DIRS or d.name.startswith("tmp-"):
            continue

        has_sdk = (d / "sdk-agent-store").is_dir()
        has_transcripts = (d / "agent-transcripts").is_dir()
        if not has_sdk and not has_transcripts:
            continue

        workspace, exact, source = resolve_workspace(d)

        # 统计 SDK agent 数量
        sdk_agents = 0
        if has_sdk:
            for store in (d / "sdk-agent-store").iterdir():
                db_path = store / "index.db"
                if db_path.exists():
                    try:
                        conn = sqlite3.connect(str(db_path))
                        sdk_agents += conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
                        conn.close()
                    except Exception:
                        pass

        # 统计 transcript 数量
        transcript_count = 0
        if has_transcripts:
            transcript_count = sum(1 for _ in (d / "agent-transcripts").iterdir())

        rows.append({
            "dir": d.name,
            "workspace": workspace,
            "exact": exact,
            "source": source,
            "sdk": has_sdk,
            "sdk_agents": sdk_agents,
            "ide": has_transcripts,
            "ide_transcripts": transcript_count,
        })

    if not rows:
        print("没有找到使用过 Agent 的项目。")
        return

    print(f"{'Workspace':40s} {'精确':4s} {'来源':16s} {'SDK':4s} {'IDE':4s}")
    print(f"{'-'*40} {'-'*4} {'-'*16} {'-'*4} {'-'*4}")
    for r in rows:
        exact_str = "✓" if r["exact"] else "推测"
        sdk_str = str(r["sdk_agents"]) if r["sdk"] else "-"
        ide_str = str(r["ide_transcripts"]) if r["ide"] else "-"
        print(f"{r['workspace']:40s} {exact_str:4s} {r['source']:16s} {sdk_str:4s} {ide_str:4s}")

    print(f"\n共 {len(rows)} 个项目使用过 Agent。")
    guessed = [r for r in rows if not r["exact"]]
    if guessed:
        print(f"（其中 {len(guessed)} 个路径无法精确反推，标记为「推测」）")


if __name__ == "__main__":
    main()
