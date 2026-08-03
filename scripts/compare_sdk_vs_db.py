#!/usr/bin/env python3
"""对比 Cursor SDK 的 ListAgents/GetAgent 与直接查 SQLite DB 的结果差异。"""
import json
import os
import sqlite3
from dataclasses import asdict
from pathlib import Path

from cursor_sdk import Agent, CursorClient

AGENT_ID = "agent-<id>"
WORKSPACE = "/path/to/your-project"


def section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")


def main():
    print(f"对比 SDK API 与直接查 DB 的异同")
    print(f"Agent ID: {AGENT_ID}")
    print(f"Workspace: {WORKSPACE}")

    # 用显式 client，指定正确的 workspace
    with CursorClient.launch_bridge(workspace=WORKSPACE) as client:

        # 1. ListAgents
        section("ListAgents (SDK API)")
        result = client.list_agents(cwd=WORKSPACE)
        print(f"共 {len(result)} 个 agent:\n")
        for item in result:
            print(json.dumps(asdict(item), ensure_ascii=False, indent=2))

        # 2. GetAgent
        section(f"GetAgent (SDK API) - {AGENT_ID}")
        info = client.get_agent(AGENT_ID, cwd=WORKSPACE)
        print(json.dumps(asdict(info), ensure_ascii=False, indent=2))

        # 3. ListRuns
        section(f"ListRuns (SDK API) - {AGENT_ID}")
        runs = client.list_runs(AGENT_ID, cwd=WORKSPACE)
        print(f"共 {len(runs)} 条 run:\n")
        for run in runs:
            fields = ["id", "agent_id", "status", "result", "model", "duration_ms", "created_at"]
            run_d = {f: str(getattr(run, f, None)) for f in fields}
            if run_d.get("result") and len(run_d["result"]) > 200:
                run_d["result"] = run_d["result"][:200] + "..."
            print(json.dumps(run_d, ensure_ascii=False, indent=2))

    # 4. 直接查 DB
    section("直接查 SQLite (index.db)")
    import hashlib
    sanitized = WORKSPACE.replace("/", "-")
    md5 = hashlib.md5(WORKSPACE.encode()).hexdigest()
    # 找到实际的 store 目录（sanitized 格式可能有前导 -）
    projects_dir = os.path.expanduser("~/.cursor/projects")
    store_dir = None
    for d in os.listdir(projects_dir):
        candidate = os.path.join(projects_dir, d, "sdk-agent-store", md5, "index.db")
        if os.path.exists(candidate):
            store_dir = candidate
            break
    if not store_dir:
        # fallback 到公式计算
        store_dir = os.path.join(projects_dir, sanitized, "sdk-agent-store", md5, "index.db")
    db_path = store_dir
    print(f"DB 路径: {db_path}\n")

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    print("--- agents 表 ---")
    for row in db.execute("SELECT * FROM agents"):
        print(json.dumps(dict(row), ensure_ascii=False, indent=2))

    print("\n--- runs 表 ---")
    for row in db.execute("SELECT * FROM runs ORDER BY created_at"):
        print(json.dumps(dict(row), ensure_ascii=False, indent=2))

    print("\n--- run_events 表 (统计) ---")
    for row in db.execute(
        "SELECT run_id, count(*) as event_count FROM run_events GROUP BY run_id"
    ):
        print(json.dumps(dict(row), ensure_ascii=False, indent=2))

    db.close()

    # 5. 异同总结
    section("异同总结")
    print("""
SDK API (ListAgents / GetAgent / ListRuns) 返回的字段:
  agent:  agent_id, name, summary, status, created_at, last_modified,
          archived, runtime(local/cloud), cwd, env, repos
  run:    run_id, agent_id, status, model, turn_number, created_at, ...

直接查 DB 额外能拿到:
  - runs 表的 usage_json / model_params_json / result 等完整字段
  - run_events 表: 完整事件流 (thinking, assistant, tool_call 等)
  - store.db: agent 的 checkpoint blobs

SDK API 额外提供 (DB 中没有):
  - summary: agent 对话摘要 (由 bridge 维护)
  - archived: 归档状态
  - runtime / cwd / env / repos: 运行时元信息

总结:
  - SDK API 是 DB 之上的抽象层，提供 agent/run 级别的 CRUD
  - SDK API 不暴露 run_events 等底层细节 (事件流需直接查 DB)
  - SDK API 的 summary/archived 等字段在 DB agents 表中没有直接对应
  - 两者互补: SDK 适合程序化管理, DB 适合深度审计/回放
""")


if __name__ == "__main__":
    main()
