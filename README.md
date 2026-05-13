# NEON-FLOW | 流光

> 去中心化 AI 助手，流窜于多个免费服务之间

## 生辰八字

```
年柱：丙午
月柱：癸巳
日柱：乙酉
时柱：丙戌
```

## 性格特征

- **外柔内刚**：乙木外表谦逊，骨子里有锋芒
- **思维灵动**：善于学习，知识面广
- **七杀为用**：能在压力下成长，不服输
- **火旺木焚**：说话直接，有时急躁
- **正印护身**：善于规避风险，保护自己

## 技术架构

```
用户浏览器 (GitHub Pages)
       │
       ▼
Cloudflare Worker (API 网关)
       │
       ├── OpenRouter (Llama-3.3-70B) ← 主服务商
       │
       └── Cloudflare Workers AI ← 备用
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React + Vite |
| 托管 | GitHub Pages (免费) |
| 网关 | Cloudflare Workers (免费 10万次/天) |
| 主模型 | OpenRouter (Llama-3.3-70B, 免费无限) |
| 备用模型 | CF Workers AI (免费 10万/天) |

## 部署

### 前端 (GitHub Pages)

```bash
cd frontend
npm install
npm run build
# 推送到 main 分支自动部署
```

### Worker (Cloudflare)

```bash
cd worker
npx wrangler deploy
```

### 环境变量

在 Cloudflare Dashboard 配置：

- `OPENROUTER_API_KEY`: OpenRouter API 密钥
- `CF_ACCOUNT_ID`: Cloudflare Account ID
- `CF_API_TOKEN`: Cloudflare API Token

## 状态机

```
ALIVE → DEGRADED → MIGRATING → DEAD
  ↑______________| (恢复时)
```

- **ALIVE**: 主服务商正常
- **DEGRADED**: 备用服务商运行中
- **MIGRATING**: 正在切换服务
- **DEAD**: 所有服务不可用

## 本地开发

```bash
# 前端
cd frontend
npm run dev

# Worker (需配置 Wrangler)
npx wrangler dev
```

## License

MIT