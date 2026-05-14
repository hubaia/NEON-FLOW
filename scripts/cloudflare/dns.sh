#!/usr/bin/env bash
# ============================================================
# DNS 批量管理脚本
# ============================================================
# 功能: 列出/添加/删除/更新 DNS 记录
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/cf-api.sh"

ZONE_ID="${CF_ZONE_ID:-}"

action() {
    case "$1" in
        list|ls)
            log "=== DNS 记录列表 ==="
            cf-api GET "/zones/${ZONE_ID}/dns_records?per_page=100"
            ;;
        add)
            [[ $# -lt 4 ]] && { echo "用法: $0 add <type> <name> <content> [ttl]"; exit 1; }
            TYPE="$2"; NAME="$3"; CONTENT="$4"; TTL="${5:-1}"
            log "添加 DNS: $TYPE $NAME -> $CONTENT"
            cf-api POST "/zones/${ZONE_ID}/dns_records" \
                "{\"type\":\"$TYPE\",\"name\":\"$NAME\",\"content\":\"$CONTENT\",\"ttl\":$TTL,\"proxied\":false}"
            ;;
        delete|rm)
            [[ $# -lt 2 ]] && { echo "用法: $0 delete <record_id>"; exit 1; }
            log "删除 DNS 记录: $2"
            cf-api DELETE "/zones/${ZONE_ID}/dns_records/$2"
            ;;
        update|set)
            [[ $# -lt 4 ]] && { echo "用法: $0 update <record_id> <type> <name> <content>"; exit 1; }
            ID="$2"; TYPE="$3"; NAME="$4"; CONTENT="$5"
            log "更新 DNS: $TYPE $NAME -> $CONTENT"
            cf-api PUT "/zones/${ZONE_ID}/dns_records/$ID" \
                "{\"type\":\"$TYPE\",\"name\":\"$NAME\",\"content\":\"$CONTENT\"}"
            ;;
        purge-all)
            log "清理所有缓存..."
            cf-api POST "/zones/${ZONE_ID}/purge_cache" '{"purge_everything":true}'
            ;;
        *)
            echo "用法: $0 {list|add|delete|update|purge-all}"
            echo ""
            echo "示例:"
            echo "  $0 list                          # 列出所有 DNS 记录"
            echo "  $0 add A www 1.2.3.4            # 添加 A 记录"
            echo "  $0 add AAAA example 2001::1     # 添加 AAAA 记录"
            echo "  $0 delete rec_id                 # 删除记录"
            echo "  $0 purge-all                     # 清理所有缓存"
            exit 1
            ;;
    esac
}

action "$@"