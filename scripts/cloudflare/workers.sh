#!/usr/bin/env bash
# ============================================================
# Workers 管理脚本
# ============================================================
# 功能: 部署/列出/删除 Workers
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/cf-api.sh"

SCRIPT_NAME="${1:-}"
ACTION="${2:-}"

case "$ACTION" in
    list|ls)
        log "=== Workers Scripts ==="
        cf-api GET "/accounts/${CF_ACCOUNT_ID}/workers/scripts?per_page=100"
        ;;
    deploy)
        [[ $# -lt 3 ]] && { echo "用法: $0 <script_name> deploy <script_dir>"; exit 1; }
        SCRIPT_NAME="$1"; DEPLOY_ACTION="deploy"; SCRIPT_DIR_PATH="$3"
        log "部署 Worker: $SCRIPT_NAME"
        # 使用 wrangler 上传
        if command -v wrangler &>/dev/null; then
            (cd "$SCRIPT_DIR_PATH" && wrangler deploy --name "$SCRIPT_NAME")
        else
            err "需要安装 wrangler: npm i -g wrangler"
        fi
        ;;
    delete|rm)
        [[ $# -lt 2 ]] && { echo "用法: $0 <script_name> delete"; exit 1; }
        log "删除 Worker: $SCRIPT_NAME"
        cf-api DELETE "/accounts/${CF_ACCOUNT_ID}/workers/scripts/$SCRIPT_NAME"
        ;;
    logs)
        [[ $# -lt 2 ]] && { echo "用法: $0 <script_name> logs [tail]"; exit 1; }
        if [[ "${3:-}" == "tail" ]]; then
            log "实时 tail Worker 日志..."
            wrangler tail --name "$SCRIPT_NAME"
        else
            log "获取 Worker 最近的日志..."
            cf-api GET "/accounts/${CF_ACCOUNT_ID}/workers/scripts/$SCRIPT_NAME/logs"
        fi
        ;;
    *)
        echo "用法:"
        echo "  $0 <script_name> list                        # 列出所有 Workers"
        echo "  $0 <script_name> deploy <dir>              # 部署 Worker"
        echo "  $0 <script_name> delete                     # 删除 Worker"
        echo "  $0 <script_name> logs [tail]               # 查看日志"
        exit 1
        ;;
esac