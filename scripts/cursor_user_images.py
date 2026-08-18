#!/usr/bin/env python3
"""列出 Cursor Web Chat composer 旁路落盘的上传图，并对上当前工作区 SQLite 里该轮用户文本。

用法:
  python scripts/cursor_user_images.py --cwd /path/to/workspace
  python scripts/cursor_user_images.py --cwd /path/to/workspace --limit 20
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DEFAULT_LIMIT = 20
PREVIEW_CHARS = 120
USER_QUERY_RE = re.compile(r"<user_query>\r?\n?([\s\S]*?)\r?\n?</user_query>", re.I)

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
DEFAULT_IMAGES_DIR = REPO_ROOT / "data" / "user-images"


def find_index_db(workspace: str) -> Path:
    """根据 workspace 路径找到对应的 index.db（与 cursor_agents.py 同源）。"""
    sanitized = os.path.abspath(workspace).lstrip("/").replace("/", "-")
    md5 = hashlib.md5(os.path.abspath(workspace).encode()).hexdigest()
    projects_dir = os.path.expanduser("~/.cursor/projects")

    for d in os.listdir(projects_dir):
        candidate = Path(projects_dir) / d / "sdk-agent-store" / md5 / "index.db"
        if candidate.is_file():
            return candidate

    raise FileNotFoundError(
        f"未找到 workspace '{workspace}' 对应的 agent store。\n"
        f"  sanitized: {sanitized}\n"
        f"  md5: {md5}\n"
        f"  搜索目录: {projects_dir}"
    )


def store_db_for_agent(index_db: Path, agent_id: str) -> Path:
    digest = hashlib.sha256(agent_id.encode()).hexdigest()
    return index_db.parent / "agents" / f"agent-{digest}" / "store.db"


def fmt_time(iso_str: str | None) -> str:
    if not iso_str:
        return "-"
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return iso_str


def preview_text(text: str) -> str:
    one = re.sub(r"\s+", " ", text).strip()
    if len(one) <= PREVIEW_CHARS:
        return one
    return one[: PREVIEW_CHARS - 3] + "..."


def blob_id_from_ref_json(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    blob = obj.get("blobId") or obj.get("rootBlobId")
    return blob if isinstance(blob, str) and blob else None


def read_varint(data: bytes, offset: int) -> tuple[int, int] | None:
    value = 0
    shift = 0
    i = offset
    while i < len(data) and shift <= 28:
        b = data[i]
        i += 1
        value |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return value, i
        shift += 7
    return None


def extract_child_blob_ids(data: bytes) -> list[str]:
    ids: list[str] = []
    i = 0
    n = len(data)
    while i < n:
        tag_start = i
        tag = read_varint(data, i)
        if not tag:
            break
        tag_value, i = tag
        wire_type = tag_value & 7
        if wire_type == 2:
            ln = read_varint(data, i)
            if not ln:
                break
            length, i = ln
            if length == 32 and i + 32 <= n:
                ids.append(data[i : i + 32].hex())
            i += length
        elif wire_type == 0:
            skip = read_varint(data, i)
            if not skip:
                break
            i = skip[1]
        elif wire_type == 5:
            i += 4
        elif wire_type == 1:
            i += 8
        else:
            i = tag_start + 1
    return ids


def try_decode_utf8(data: bytes) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def try_extract_user_role_json(data: bytes) -> str | None:
    raw = try_decode_utf8(data)
    if not raw or not raw.startswith("{"):
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or obj.get("role") != "user":
        return None
    content = obj.get("content")
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "text":
            continue
        text = part.get("text")
        if isinstance(text, str):
            parts.append(text)
    if not parts:
        return None
    joined = "\n".join(parts)
    m = USER_QUERY_RE.search(joined)
    text = (m.group(1) if m else joined).strip()
    return text or None


def try_extract_protobuf_field1_text(data: bytes) -> str | None:
    if len(data) < 2 or data[0] != 0x0A:
        return None
    ln = read_varint(data, 1)
    if not ln:
        return None
    length, nxt = ln
    if length <= 0 or nxt + length > len(data):
        return None
    text_bytes = data[nxt : nxt + length]
    if len(text_bytes) < len(data) * 0.5:
        return None
    text = try_decode_utf8(text_bytes)
    if not text:
        return None
    if "<user_query>" in text or '"toolCallId"' in text:
        return None
    trimmed = text.strip()
    return trimmed or None


def collect_reachable_blob_ids(get_blob, root_blob_id: str | None) -> dict[str, None]:
    """DFS 访问序（与 checkpointUserText.ts 的 Set 插入序一致）。"""
    out: dict[str, None] = {}
    if not root_blob_id:
        return out
    queue = [root_blob_id]
    while queue:
        blob_id = queue.pop()
        if blob_id in out:
            continue
        out[blob_id] = None
        data = get_blob(blob_id)
        if not data:
            continue
        for child in extract_child_blob_ids(data):
            if child not in out:
                queue.append(child)
    return out


def extract_user_text_from_checkpoint_diff(
    get_blob,
    start_root: str | None,
    latest_root: str | None,
) -> str | None:
    if not latest_root:
        return None
    try:
        start_set = collect_reachable_blob_ids(get_blob, start_root)
        latest_set = collect_reachable_blob_ids(get_blob, latest_root)
        for blob_id in latest_set:
            if blob_id in start_set:
                continue
            data = get_blob(blob_id)
            if not data:
                continue
            text = try_extract_user_role_json(data) or try_extract_protobuf_field1_text(data)
            if text:
                return text
    except Exception:
        return None
    return None


@dataclass
class ImageFile:
    path: Path
    run_id: str
    mtime: float


def list_image_files(images_dir: Path) -> list[ImageFile]:
    if not images_dir.is_dir():
        return []
    out: list[ImageFile] = []
    for p in images_dir.iterdir():
        if not p.is_file():
            continue
        if p.name.endswith(".tmp"):
            continue
        ext = p.suffix.lower()
        if ext not in IMAGE_EXTS:
            continue
        stem = p.stem
        if not stem or ".." in stem or "/" in stem or "\\" in stem:
            continue
        out.append(ImageFile(path=p.resolve(), run_id=stem, mtime=p.stat().st_mtime))
    out.sort(key=lambda x: x.mtime, reverse=True)
    return out


def open_ro(db_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def load_run_map(index_db: Path) -> dict[str, sqlite3.Row]:
    db = open_ro(index_db)
    try:
        rows = db.execute(
            "SELECT run_id, agent_id, turn_number, status, created_at, "
            "start_checkpoint_ref_json, latest_checkpoint_ref_json FROM runs"
        ).fetchall()
        return {r["run_id"]: r for r in rows}
    finally:
        db.close()


def load_agent_names(index_db: Path) -> dict[str, str]:
    db = open_ro(index_db)
    try:
        return {
            r["agent_id"]: r["name"] or ""
            for r in db.execute("SELECT agent_id, name FROM agents")
        }
    finally:
        db.close()


class BlobStore:
    def __init__(self, store_db: Path):
        self._path = store_db
        self._db: sqlite3.Connection | None = None
        self._cache: dict[str, bytes | None] = {}

    def get(self, blob_id: str) -> bytes | None:
        if blob_id in self._cache:
            return self._cache[blob_id]
        if self._db is None:
            if not self._path.is_file():
                self._cache[blob_id] = None
                return None
            self._db = open_ro(self._path)
        row = self._db.execute("SELECT data FROM blobs WHERE id = ?", (blob_id,)).fetchone()
        data = bytes(row["data"]) if row and row["data"] is not None else None
        self._cache[blob_id] = data
        return data

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="列出网页 composer 上传图的磁盘路径，并对应当前工作区该轮用户文本。"
    )
    parser.add_argument(
        "--cwd",
        required=True,
        help="当前会话工作区绝对路径（用于定位该 cwd 的 index.db）",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"各段最多列出多少条（按文件 mtime，默认 {DEFAULT_LIMIT}）",
    )
    parser.add_argument(
        "--images-dir",
        default=str(DEFAULT_IMAGES_DIR),
        help="旁路图片目录（默认本仓库 data/user-images）",
    )
    args = parser.parse_args()
    if args.limit < 1:
        print("--limit 必须 >= 1", file=sys.stderr)
        return 2

    cwd = os.path.abspath(args.cwd)
    images_dir = Path(args.images_dir)
    files = list_image_files(images_dir)

    try:
        index_db = find_index_db(cwd)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1

    run_map = load_run_map(index_db)
    agent_names = load_agent_names(index_db)
    blob_stores: dict[str, BlobStore] = {}

    matched: list[ImageFile] = []
    unmatched: list[ImageFile] = []
    for f in files:
        if f.run_id in run_map:
            matched.append(f)
        else:
            unmatched.append(f)

    print(f"Workspace: {cwd}")
    print(f"DB: {index_db}")
    print(f"Images: {images_dir.resolve()}")
    print(f"旁路文件 {len(files)} 个；当前工作区匹配 {len(matched)} 个；未匹配 {len(unmatched)} 个")
    print()

    def user_preview(run: sqlite3.Row) -> str:
        agent_id = run["agent_id"]
        store = blob_stores.get(agent_id)
        if store is None:
            store = BlobStore(store_db_for_agent(index_db, agent_id))
            blob_stores[agent_id] = store
        start = blob_id_from_ref_json(run["start_checkpoint_ref_json"])
        latest = blob_id_from_ref_json(run["latest_checkpoint_ref_json"])
        text = extract_user_text_from_checkpoint_diff(store.get, start, latest)
        if not text:
            return "未能还原用户原文"
        return preview_text(text)

    print(f"── 当前工作区（mtime 近 {args.limit} 张）──")
    if not matched:
        print("  （无）")
    else:
        for f in matched[: args.limit]:
            run = run_map[f.run_id]
            agent_id = run["agent_id"]
            name = agent_names.get(agent_id) or "-"
            print(f"  {f.path}")
            print(
                f"    run_id={run['run_id']}  turn={run['turn_number']}  "
                f"status={run['status']}  created={fmt_time(run['created_at'])}"
            )
            print(f"    agent={agent_id}  name={name}")
            print(f"    用户: {user_preview(run)}")
            print()

    print(f"── 未匹配当前工作区（mtime 近 {args.limit} 张，勿当成本会话附图）──")
    if not unmatched:
        print("  （无）")
    else:
        for f in unmatched[: args.limit]:
            print(f"  {f.path}  run_id={f.run_id}")
        rest = len(unmatched) - min(args.limit, len(unmatched))
        if rest > 0:
            print(f"  …另有 {rest} 个未列出")

    for s in blob_stores.values():
        s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
