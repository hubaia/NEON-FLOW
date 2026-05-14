# Cloudflare 脚本化工具

> 流光的 Cloudflare 运维工具集，告别手动点点点

## 文件结构

```
scripts/cloudflare/
├── README.md              # 本文件
├── config.template        # 配置模板（复制为 config.env）
├── cf-api.sh              # 核心 API 调用（所有脚本依赖此文件）
├── dns.sh                 # DNS 记录管理
├── pagerules.sh           # Page Rules 管理
├── workers.sh             # Workers 部署与日志
└── status.sh              # 全局状态查看
```

## 快速开始

### 1. 配置 Token

```bash
cd scripts/cloudflare
cp config.template config.env
# 编辑 config.env，填入：
#   CF_API_TOKEN=your_token_here
#   CF_ACCOUNT_ID=your_account_id
#   CF_ZONE_ID=your_zone_id (可选)
```

**获取方式**：
- `CF_API_TOKEN`: Dashboard → Profile → API Tokens → Create Custom Token
- `CF_ACCOUNT_ID`: 任意域名 Overview 页面底部
- `CF_ZONE_ID`: 域名 Overview 页面

### 2. 设置执行权限

```bash
chmod +x *.sh
```

### 3. 开始使用

```bash
# 查看全局状态
./status.sh all

# 查看 DNS 记录
./dns.sh list

# 添加 DNS 记录
./dns.sh add A www 1.2.3.4

# 清理缓存
./dns.sh purge-all

# 查看 Workers
./workers.sh list

# 部署 Worker
./workers.sh my-worker deploy /path/to/worker/dir
```

## 常用操作

| 操作 | 命令 |
|------|------|
| 列出所有域名 | `./status.sh all` |
| 列出 DNS | `./dns.sh list` |
| 添加 A 记录 | `./dns.sh add A sub 1.2.3.4` |
| 删除 DNS | `./dns.sh delete rec_id` |
| 清理所有缓存 | `./dns.sh purge-all` |
| 查看流量 | `./status.sh analytics` |
| 查看 WAF | `./status.sh waf` |
| 查看 SSL | `./status.sh ssl` |
| 列出 Workers | `./workers.sh list` |
| 实时日志 | `./workers.sh my-worker logs tail` |

## API 能力

所有 Dashboard 能做的，API 都能做：

- [x] DNS 管理（添加/删除/修改/查询）
- [x] 缓存清理（purge）
- [x] Page Rules（重定向/HTTPS/缓存策略）
- [x] Workers（部署/删除/日志）
- [x] Firewall 规则
- [x] WAF 规则组
- [x] 流量分析
- [x] SSL/TLS 设置
- [x] 账户信息

## 注意事项

⚠️ **必须手动的情况**：
- 账户根级别的敏感操作（删除账户、更改账单）
- 触发 CAPTCHA 验证时
- 需要 Email 二次确认的操作

⚠️ **Rate Limit**：
- 默认 1200 请求/5分钟
- 批量操作建议加延迟：`sleep 0.5`

## 扩展

如果需要 Python 版本或 Terraform IaC 版本，可以扩展此目录。