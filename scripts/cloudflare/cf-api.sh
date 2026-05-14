#!/usr/bin/env bash
# ============================================================
# Cloudflare API Core - 流光工具集
# ============================================================
# 用法: cf-api.sh <method> <endpoint> [json_body]
# 示例: cf-api.sh GET "/zones"
# ============================================================

set -euo pipefail

# 配置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.env"

# 加载配置
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
fi

# 默认值
: "${CF_API_TOKEN:?请设置 CF_API_TOKEN (config.env)}"
: "${CF_ACCOUNT_ID:?请设置 CF_ACCOUNT_ID}"

CF_API_BASE="https://api.cloudflare.com/client/v4"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[CF]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERR]${NC} $1" >&2; exit 1; }

# HTTP 方法映射
METHOD=""
case "$1" in
    GET|get) METHOD="GET" ;;
    POST|post) METHOD="POST" ;;
    PUT|put) METHOD="PUT" ;;
    PATCH|patch) METHOD="PATCH" ;;
    DELETE|delete) METHOD="DELETE" ;;
    *) err "未知方法: $1" ;;
esac
shift

ENDPOINT="$1"
BODY="${3:-}"

# 构建 curl
CMD="curl -s -X $METHOD"
CMD="$CMD \"$CF_API_BASE$ENDPOINT\""
CMD="$CMD -H \"Authorization: Bearer $CF_API_TOKEN\""
CMD="$CMD -H \"Content-Type: application/json\""

if [[ -n "$BODY" ]]; then
    CMD="$CMD -d '$BODY'"
fi

# 执行并美化 JSON
RESULT=$(eval "$CMD" | python3 -m json.tool 2>/dev/null || eval "$CMD")

echo "$RESULT"