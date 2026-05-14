# Cloudflare Workflows 实现流光回复

## 架构

```
用户请求 → Worker /api/workflow/reply
              ↓
         创建 Workflow Instance
              ↓
         NeonFlowReplyWorkflow.run()
              ↓
    ┌──────────┼──────────┐
    ↓          ↓          ↓
Step 1    Step 2     Step 3
验证消息   调用API    保存历史
              ↓
         自动重试
         (最多3次)
              ↓
         返回结果
```

## 文件

```
worker/
├── src/
│   └── workflow.ts        # Workflow 定义
├── index.js              # Worker 主入口（新增 Workflow 触发接口）
└── wrangler.toml         # 新增 workflows 配置
```

## API 接口

### 1. 触发 Workflow（异步）

```
POST /api/workflow/reply
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "sessionId": "可选",      // 会话 ID
  "userId": "可选"          // 用户标识
}

响应：
{
  "ok": true,
  "instanceId": "wf-xxx",   // Workflow 实例 ID
  "status": "running",
  "message": "Workflow 已触发，请通过 GET /api/workflow/status/{instanceId} 查询结果"
}
```

### 2. 查询状态（轮询）

```
GET /api/workflow/status/{instanceId}

响应（running）：
{
  "id": "wf-xxx",
  "status": "running",
  "output": null,
  "error": null
}

响应（completed）：
{
  "id": "wf-xxx",
  "status": "completed",
  "output": {
    "content": "流光的回复...",
    "model": "...",
    "sessionId": "...",
    "requestId": "..."
  },
  "error": null
}
```

## Workflow 优势

| 特性 | Worker 直接调用 | Workflow |
|------|---------------|----------|
| 自动重试 | ❌ 需要手动写 | ✅ 内置，最多3次 |
| 持久状态 | ❌ 超时丢失 | ✅ 中断后可恢复 |
| 长时等待 | ❌ 15s 超时 | ✅ 可 sleep 数小时 |
| 并发控制 | ❌ 重复调用 | ✅ 可等待事件 |
| 调试回放 | ❌ 无 | ✅ 完整步骤记录 |

## 使用场景

适合：
- **AI 回复生成**（不用怕 API 暂时不可用）
- **长链任务**（多步骤处理，每步可独立重试）
- **事件驱动**（等待外部 webhook 确认后再继续）

不太适合：
- **实时对话**（Workflow 触发有延迟，不适合 1s 内响应）

## 部署

```bash
cd worker
wrangler deploy
```

## Workflow 内部流程

```
1. validate messages   → 检查消息格式
2. call neon-flow api   → 调用流光 AI（自动重试3次）
3. save to history      → 可选：保存到 KV
4. return result       → 返回 content/model/sessionId
```

## 注意

- Workflow 实例 ID 可以用来查询状态和结果
- 实例状态：`queued` → `running` → `completed` / `failed`
- 失败时 `error` 字段包含错误信息