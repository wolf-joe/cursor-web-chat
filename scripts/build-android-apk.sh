#!/usr/bin/env bash
# 给真机的 debug APK:先升版本再 assembleDebug。
# 拷贝目录 / 对外下载 URL 只读 android/apk-dist.local.properties(gitignore),本脚本不写死。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROPS="$ROOT/android/version.properties"
DIST_PROPS="$ROOT/android/apk-dist.local.properties"

bump=1
if [[ "${1:-}" == "--no-bump" ]]; then
  bump=0
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "usage: $0 [--no-bump]"
  echo "  默认 versionCode+1、versionName 末段+1,然后 ./gradlew assembleDebug"
  echo "  --no-bump  用当前版本重编(不覆盖安装时才需要)"
  echo "  可选 android/apk-dist.local.properties: apk.dist.dir / apk.dist.name / apk.dist.url"
  exit 0
elif [[ $# -gt 0 ]]; then
  echo "unknown arg: $1" >&2
  exit 2
fi

ver_line="$(
  python3 - "$PROPS" "$bump" <<'PY'
import re, sys
from pathlib import Path

path = Path(sys.argv[1])
bump = sys.argv[2] == "1"
text = path.read_text(encoding="utf-8")
code_m = re.search(r"^versionCode=(\d+)\s*$", text, re.M)
name_m = re.search(r"^versionName=(\S+)\s*$", text, re.M)
if not code_m or not name_m:
    raise SystemExit(f"cannot parse {path}")
code = int(code_m.group(1))
name = name_m.group(1)
if bump:
    code += 1
    parts = name.split(".")
    if not parts or not parts[-1].isdigit():
        raise SystemExit(f"versionName last segment must be int: {name}")
    parts[-1] = str(int(parts[-1]) + 1)
    name = ".".join(parts)

    def one(key: str, new: str, src: str) -> str:
        pat = re.compile(rf"^({re.escape(key)}=).+$", re.M)
        if not pat.search(src):
            raise SystemExit(f"missing {key} in {path}")
        return pat.sub(rf"\g<1>{new}", src, count=1)

    text = one("versionCode", str(code), text)
    text = one("versionName", name, text)
    path.write_text(text, encoding="utf-8")
print(f"{code} {name}")
PY
)"
read -r VERSION_CODE VERSION_NAME <<< "$ver_line"
echo "building $VERSION_NAME ($VERSION_CODE)"

cd "$ROOT/android"
./gradlew assembleDebug

if [[ -f "$DIST_PROPS" ]]; then
  url="$(python3 - "$DIST_PROPS" <<'PY'
import sys
from pathlib import Path
for raw in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("apk.dist.url="):
        print(line.split("=", 1)[1].strip().strip('"'))
        break
PY
)"
  if [[ -n "${url}" ]]; then
    echo "download: $url"
  fi
fi
