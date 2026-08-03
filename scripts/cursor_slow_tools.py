#!/usr/bin/env python3
"""Cursor Agent 工具调用异常扫描器。

直接读本地 SqliteLocalAgentStore 的 index.db(和 cursor_agents.py 走的是同一份数据),
按 call_id 把每次工具调用的 running -> completed 配对起来,找两类异常:

  1. 慢工具调用: running 到 completed 之间的耗时超过阈值(默认 5 秒)。
     附带一个专项检查:shell 工具如果声明了 args.timeout,但实际 executionTime
     远超这个 timeout 却仍然 status=success——说明 SDK 的 shell 超时不是"到点就杀进程",
     而是"到点转后台、跑完再报告"(实测坐实,见对话记录),这里直接标出来提醒别被
     "完成状态是 success"误导。
  2. 卡住/丢失的工具调用: 只出现过 running 事件,这一整个 run 里再也没见到
     这个 call_id 的 completed/error——真实案例证明这种调用不是"慢",而是
     模型自己判断"卡住了"发起重试(thinking 里会出现"正在重试工具调用"),
     原始那次调用的完成事件从未写入过。

用法:
  # 扫描整个 workspace 下所有 agent 的所有 run(默认只打印有问题的 run)
  python cursor_slow_tools.py /path/to/your-project

  # 只看某个 agent
  python cursor_slow_tools.py /path/to/your-project -a agent-<id>

  # 只看某个 agent 的某一轮
  python cursor_slow_tools.py /path/to/your-project -a agent-<id> -t 11

  # 调低慢调用阈值到 2 秒,连同没有异常的 run 也打印出来
  python cursor_slow_tools.py /path/to/your-project --min-duration 2 --all
"""
import argparse
import hashlib
import json
import os
import sqlite3
from datetime import datetime


def find_index_db(workspace: str) -> str:
    """根据 workspace 路径找到对应的 index.db(与 cursor_agents.py 逻辑一致)。"""
    md5 = hashlib.md5(os.path.abspath(workspace).encode()).hexdigest()
    projects_dir = os.path.expanduser("~/.cursor/projects")

    for d in os.listdir(projects_dir):
        candidate = os.path.join(projects_dir, d, "sdk-agent-store", md5, "index.db")
        if os.path.exists(candidate):
            return candidate

    raise FileNotFoundError(
        f"未找到 workspace '{workspace}' 对应的 agent store。\n"
        f"  md5: {md5}\n"
        f"  搜索目录: {projects_dir}"
    )


def parse_iso(iso_str: str | None) -> datetime | None:
    if not iso_str:
        return None
    try:
        return datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except Exception:
        return None


def fmt_time(iso_str: str | None) -> str:
    dt = parse_iso(iso_str)
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S") if dt else "-"


def fmt_secs(secs: float) -> str:
    if secs < 60:
        return f"{secs:.1f}s"
    return f"{secs / 60:.1f}m"


def tool_detail(args: dict | None) -> str:
    if not isinstance(args, dict):
        return ""
    detail = args.get("path") or args.get("pattern") or args.get("command") or ""
    return str(detail)[:80]


def analyze_run(db: sqlite3.Connection, run: sqlite3.Row, min_duration: float) -> dict:
    """返回 {"slow": [...], "stuck": [...]},每项都是可直接打印的 dict。"""
    events = list(db.execute(
        "SELECT seq, created_at, payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
        (run["run_id"],),
    ))

    calls = {}  # call_id -> {name, args, start, end, end_status}
    for ev in events:
        if not ev["payload_json"]:
            continue
        msg = json.loads(ev["payload_json"]).get("message", {})
        if msg.get("type") != "tool_call":
            continue
        cid = msg.get("call_id")
        if cid is None:
            continue
        c = calls.setdefault(cid, {"name": msg.get("name"), "args": msg.get("args"), "start": None, "end": None, "end_status": None})
        status = msg.get("status")
        t = parse_iso(ev["created_at"])
        if status == "running" and c["start"] is None:
            c["start"] = t
        elif status != "running":
            c["end"] = t
            c["end_status"] = status
            # completed 时把 result 一并记下,专项检查 shell 的 timeout 用得上
            c["result"] = msg.get("result")

    run_end = parse_iso(run["finished_at"]) or parse_iso(run["updated_at"])

    slow, stuck = [], []
    for cid, c in calls.items():
        if c["start"] is None:
            continue  # 没见过 running 事件,理论不该发生,跳过
        if c["end"] is None:
            # 卡住:整个 run 里这个 call_id 再没出现过
            stalled_for = (run_end - c["start"]).total_seconds() if run_end else None
            stuck.append({
                "call_id": cid,
                "name": c["name"],
                "detail": tool_detail(c["args"]),
                "start": c["start"],
                "stalled_for": stalled_for,
            })
            continue

        duration = (c["end"] - c["start"]).total_seconds()
        if duration < min_duration:
            continue

        note = None
        if c["name"] == "shell":
            args = c["args"] or {}
            timeout_ms = args.get("timeout")
            result = c.get("result") or {}
            exec_ms = None
            if isinstance(result, dict) and result.get("status") == "success":
                exec_ms = (result.get("value") or {}).get("executionTime")
            if isinstance(timeout_ms, (int, float)) and isinstance(exec_ms, (int, float)) and exec_ms > timeout_ms:
                note = f"声明 timeout={timeout_ms}ms,实际执行 {exec_ms}ms(超出 {exec_ms / timeout_ms:.1f}x)仍返回 success——SDK 的 shell 超时是转后台继续跑,不是到点杀进程"

        slow.append({
            "call_id": cid,
            "name": c["name"],
            "detail": tool_detail(c["args"]),
            "duration": duration,
            "note": note,
        })

    slow.sort(key=lambda x: -x["duration"])
    return {"slow": slow, "stuck": stuck}


def print_run_findings(agent_name: str, run: sqlite3.Row, findings: dict):
    print(f"Agent: {agent_name} ({run['agent_id']})")
    print(f"Turn {run['turn_number']}  run_id={run['run_id']}  状态={run['status']}  模型={run['model']}")
    print(f"  创建: {fmt_time(run['created_at'])}   结束: {fmt_time(run['finished_at'])}")

    if findings["slow"]:
        print(f"  ⚠ 慢工具调用(>= 阈值):")
        for s in findings["slow"]:
            line = f"    {fmt_secs(s['duration']):>8}  {s['name']:10s}  {s['detail']}"
            print(line)
            if s["note"]:
                print(f"              └─ {s['note']}")

    if findings["stuck"]:
        print(f"  ⚠ 卡住/丢失的工具调用(只有 running,没有 completed):")
        for s in findings["stuck"]:
            stalled = fmt_secs(s["stalled_for"]) if s["stalled_for"] is not None else "未知(run 未结束)"
            print(f"    {s['name']:10s}  {s['detail']}  从 {fmt_time(s['start'].isoformat())} 起卡了 {stalled}  call_id={s['call_id']}")

    print()


def main():
    parser = argparse.ArgumentParser(
        description="扫描 Cursor Agent 的工具调用,找慢调用和卡住没有 completed 的调用",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s /path/to/your-project
  %(prog)s /path/to/your-project -a agent-<id>
  %(prog)s /path/to/your-project -a agent-<id> -t 11
  %(prog)s /path/to/your-project --min-duration 2 --all
        """,
    )
    parser.add_argument("workspace", help="workspace 路径(项目根目录)")
    parser.add_argument("-a", "--agent", help="只扫描指定 agent")
    parser.add_argument("-t", "--turn", type=int, help="只扫描指定 turn(需要同时指定 -a)")
    parser.add_argument("--min-duration", type=float, default=5.0, help="慢调用阈值,单位秒(默认 5)")
    parser.add_argument("--all", action="store_true", help="连同没有异常的 run 也打印(默认只打印有问题的)")
    args = parser.parse_args()

    if args.turn is not None and not args.agent:
        parser.error("使用 -t 时必须同时指定 -a")

    db_path = find_index_db(args.workspace)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    query = (
        "SELECT r.*, a.name as agent_name FROM runs r "
        "JOIN agents a ON a.agent_id = r.agent_id WHERE 1=1"
    )
    params = []
    if args.agent:
        query += " AND r.agent_id = ?"
        params.append(args.agent)
    if args.turn is not None:
        query += " AND r.turn_number = ?"
        params.append(args.turn)
    query += " ORDER BY r.created_at"

    runs = list(db.execute(query, params))
    if not runs:
        print("没有匹配的 run。")
        return

    print(f"Workspace: {args.workspace}")
    print(f"DB: {db_path}")
    print(f"共扫描 {len(runs)} 个 run,慢调用阈值 {args.min_duration}s\n")

    flagged_runs = 0
    total_slow = 0
    total_stuck = 0
    for run in runs:
        findings = analyze_run(db, run, args.min_duration)
        has_issue = bool(findings["slow"] or findings["stuck"])
        if has_issue:
            flagged_runs += 1
            total_slow += len(findings["slow"])
            total_stuck += len(findings["stuck"])
        if has_issue or args.all:
            print_run_findings(run["agent_name"], run, findings)

    db.close()

    print("── 汇总 ──")
    print(f"  有异常的 run: {flagged_runs} / {len(runs)}")
    print(f"  慢工具调用总数: {total_slow}")
    print(f"  卡住/丢失的工具调用总数: {total_stuck}")


if __name__ == "__main__":
    main()
