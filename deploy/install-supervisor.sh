#!/usr/bin/env bash
set -euo pipefail

# 将 deploy/supervisor.ini 安装到系统 Supervisor 目录。
# CURSOR_API_KEY 不写进 conf——进程启动时由 node --env-file-if-exists=.env 从仓库根加载。
# 大部分操作以普通用户运行, 仅在写入系统目录时使用 sudo, 例如:
#   ./deploy/install-supervisor.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/supervisor.ini"
ENV_FILE="${PROJECT_ROOT}/.env"
DEST_FILE="/etc/supervisor/conf.d/cursor-web-chat.conf"
NODE_PATH_PLACEHOLDER="__NODE_PATH__"

usage() {
  cat <<'EOF'
用法: install-supervisor.sh [选项]

将 deploy/supervisor.ini 拷贝到系统 Supervisor 配置目录, 并替换本机 node 路径。
密钥留在仓库根 .env, 不注入 conf。

大部分操作以普通用户运行, 仅在写入系统目录时使用 sudo。

选项:
  --env-file PATH   dotenv 文件路径 (默认: 仓库根目录 .env; 仅做存在性/密钥预检)
  --dest PATH       目标配置文件路径 (默认: /etc/supervisor/conf.d/cursor-web-chat.conf)
  -h, --help        显示此帮助

示例:
  ./deploy/install-supervisor.sh
  ./deploy/install-supervisor.sh --env-file /path/to/cursor-web-chat/.env
EOF
}

log() {
  printf '[install-supervisor] %s\n' "$*"
}

die() {
  printf '[install-supervisor] 错误: %s\n' "$*" >&2
  exit 1
}

read_env_var() {
  local file="$1"
  local name="$2"
  local line key value

  [[ -f "$file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue

    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi

    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" == "$name" ]] || continue

    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"

    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    printf '%s' "$value"
    return 0
  done <"$file"

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file 需要参数"
      ENV_FILE="$2"
      shift 2
      ;;
    --dest)
      [[ $# -ge 2 ]] || die "--dest 需要参数"
      DEST_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数: $1 (使用 --help 查看用法)"
      ;;
  esac
done

[[ -f "$TEMPLATE_FILE" ]] || die "找不到模板文件: $TEMPLATE_FILE"
[[ -f "$ENV_FILE" ]] || die "找不到 dotenv 文件: $ENV_FILE (进程靠它加载 CURSOR_API_KEY)"

if ! CURSOR_API_KEY="$(read_env_var "$ENV_FILE" "CURSOR_API_KEY")"; then
  die "在 $ENV_FILE 中未找到 CURSOR_API_KEY"
fi
# 只做预检, 不把值写进 conf; 立刻丢掉变量以免泄漏到后续步骤环境。
[[ -n "$CURSOR_API_KEY" ]] || die "CURSOR_API_KEY 为空, 请检查 $ENV_FILE"
unset CURSOR_API_KEY

NODE_PATH="$(command -v node 2>/dev/null)" || NODE_PATH=""
[[ -n "$NODE_PATH" ]] || die "找不到 node 命令, 请确保已安装 Node.js"
NODE_PATH="$(dirname "$NODE_PATH")"
log "检测到 node 路径: $NODE_PATH"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

sed -e "s|${NODE_PATH_PLACEHOLDER}|${NODE_PATH}|g" \
    "$TEMPLATE_FILE" >"$TMP_FILE"

if grep -qE 'CURSOR_API_KEY=|REPLACE_WITH_YOUR_KEY' "$TMP_FILE"; then
  die "生成的 conf 仍含密钥字段或占位符, 请检查模板 $TEMPLATE_FILE"
fi

sudo install -d "$(dirname "$DEST_FILE")"
sudo install -m 644 "$TMP_FILE" "$DEST_FILE"

log "已安装 Supervisor 配置: $DEST_FILE"
log "CURSOR_API_KEY 由进程从 $ENV_FILE 加载 (不写进 conf)"
log ""
log "下一步:"
log "  sudo supervisorctl reread"
log "  sudo supervisorctl update"
log "  sudo supervisorctl status cursor-web-chat"
