#!/usr/bin/env bash
# ============================================================
# 全局状态查看脚本
# ============================================================
# 功能: 查看账户概览、DNS、缓存、安全设置等
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/cf-api.sh"

case "${1:-status}" in
    status|all)
        echo "=== Cloudflare 全局状态 ==="
        echo ""
        echo "--- Zones ---"
        cf-api GET "/zones?per_page=50" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for z in d.get('result',[]):
    print(f\"  [{z['status']}] {z['name']} (Plan: {z['plan']['name']})\")
"
        echo ""
        echo "--- 账户信息 ---"
        cf-api GET "/accounts/${CF_ACCOUNT_ID}"
        ;;
    dns)
        log "=== DNS 概览 ==="
        cf-api GET "/zones/${CF_ZONE_ID:-}/dns_records?per_page=50"
        ;;
    analytics)
        log "=== 流量分析 (最近24小时) ==="
        cf-api GET "/zones/${CF_ZONE_ID:-}/analytics/dashboard?since=-1440&until=0"
        ;;
    cache)
        log "=== 缓存状态 ==="
        cf-api GET "/zones/${CF_ZONE_ID:-}/analytics/colos"
        ;;
    firewall)
        log "=== Firewall 规则 ==="
        cf-api GET "/zones/${CF_ZONE_ID:-}/firewall/rules?per_page=50"
        ;;
    waf)
        log "=== WAF 规则组 ==="
        cf-api GET "/zones/${CF_ZONE_ID:-}/firewall/waf/packages"
        ;;
    ssl)
        log "=== SSL/TLS 设置 ==="
        cf-api GET "/zones/${CF_ZONE_ID:-}/settings/ssl"
        ;;
    speed)
        log "=== Speed 测试数据 ==="
        cf-api GET "/zones/${CF_ZONE_ID:-}/analytics/latency"
        ;;
    workers)
        log "=== Workers 配额 ==="
        cf-api GET "/accounts/${CF_ACCOUNT_ID}/workers/usage?since=-1440&until=0"
        ;;
    *)
        echo "用法: cf-status.sh {status|all|dns|analytics|cache|firewall|waf|ssl|speed|workers}"
        exit 1
        ;;
esac