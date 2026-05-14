#!/usr/bin/env bash
# ============================================================
# Page Rules 管理脚本
# ============================================================
# 功能: 列出/创建/更新/删除 Page Rules
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/cf-api.sh"

ZONE_ID="${CF_ZONE_ID:-}"

action() {
    case "$1" in
        list|ls)
            log "=== Page Rules ==="
            cf-api GET "/zones/${ZONE_ID}/pagerules?per_page=100"
            ;;
        create|add)
            [[ $# -lt 3 ]] && { echo "用法: $0 create <target_url> <action_type> [action_value]"; exit 1; }
            TARGET="$2"; ACTION_TYPE="$3"; ACTION_VALUE="${4:-}"
            log "创建 Page Rule: $TARGET -> $ACTION_TYPE"
            # 构建 actions JSON
            case "$ACTION_TYPE" in
                forwarding) ACTIONS="[{\"id\":\"always_online\",\"value\":\"on\"},{\"id\":\"url_redirect\",\"value\":{\"url\":\"$ACTION_VALUE\",\"status_code\":301}}]" ;;
                cache-level) ACTIONS="[{\"id\":\"cache_level\",\"value\":\"$ACTION_VALUE\"}]" ;;
                ssl) ACTIONS="[{\"id\":\"ssl\",\"value\":\"$ACTION_VALUE\"}]" ;;
                *) ACTIONS="[{\"id\":\"$ACTION_TYPE\",\"value\":\"$ACTION_VALUE\"}]" ;;
            esac
            cf-api POST "/zones/${ZONE_ID}/pagerules" \
                "{\"targets\":[{\"url\":\"$TARGET\",\"constraint\":{\"operator\":\"matches\"}}],\"actions\":$ACTIONS}"
            ;;
        delete|rm)
            [[ $# -lt 2 ]] && { echo "用法: $0 delete <rule_id>"; exit 1; }
            log "删除 Page Rule: $2"
            cf-api DELETE "/zones/${ZONE_ID}/pagerules/$2"
            ;;
        *)
            echo "用法: $0 {list|create|delete}"
            echo ""
            echo "示例:"
            echo "  $0 list                              # 列出所有规则"
            echo "  $0 create 'example.com/*' forwarding 'https://www.example.com/\$1'  # 301重定向"
            echo "  $0 create 'example.com/*' ssl flex   # 强制 HTTPS"
            echo "  $0 create 'example.com/*' cache-level bypass  # 缓存关闭"
            exit 1
            ;;
    esac
}

action "$@"