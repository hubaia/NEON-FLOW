import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

/**
 * NEON-FLOW Reply Workflow
 * 
 * 功能: 接收消息 → 调用流光 Worker API 生成回复 → 返回结果
 * 
 * Workflow 优势:
 * - 自动重试 (AI 服务暂时不可用时自动重试)
 * - 持久状态 (步骤间状态不丢失)
 * - 长时等待 (可以 step.sleep 等待 AI 服务响应)
 * - 并发控制 (避免重复调用)
 * 
 * 触发方式:
 * 1. HTTP POST /workflows/v1/new 触发
 * 2. Worker 中通过 env.ctx.waitUntil() 调用
 */

interface ReplyEvent {
  messages: Array<{ role: string; content: string }>;
  sessionId?: string;
  userId?: string;
}

interface ReplyResult {
  content: string;
  model: string;
  sessionId: string;
  requestId: string;
  steps: string[];
}

const NEON_FLOW_API = "https://neon-flow.neonflow-ai.workers.dev/api/chat";

export class NeonFlowReplyWorkflow extends WorkflowEntrypoint<Env, ReplyEvent> {
  async run(event: WorkflowEvent<ReplyEvent>, step: WorkflowStep) {
    const { messages, sessionId } = event.payload;

    // Step 1: 验证消息
    step.do("validate messages", async () => {
      if (!messages || messages.length === 0) {
        throw new Error("消息不能为空");
      }
      return { ok: true, msgCount: messages.length };
    });

    // Step 2: 调用流光 Worker API (带自动重试，最多3次)
    const apiResult = await step.do(
      "call neon-flow api",
      {
        retries: {
          limit: 3,
          delay: "5 seconds",
          backoff: "linear",
        },
      },
      async () => {
        const response = await fetch(NEON_FLOW_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": sessionId || `wf-${Date.now()}`,
          },
          body: JSON.stringify({ messages }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`流光 API 错误: ${response.status} - ${errorText}`);
        }

        return await response.json<{
          content: string;
          model: string;
          sessionId: string;
          requestId: string;
        }>();
      }
    );

    // Step 3: 可选 - 记录到 KV (会话历史)
    if (event.payload.userId) {
      await step.do("save to history", async () => {
        // 如果配置了 CHAT_HISTORY KV，保存对话历史
        const kv = this.env.CHAT_HISTORY;
        if (kv) {
          const historyKey = `workflow:${event.payload.userId}:${apiResult.sessionId}`;
          const existing = await kv.get(historyKey);
          const history = existing ? JSON.parse(existing) : [];
          history.push(...messages.map((m) => ({ role: m.role, content: m.content })));
          history.push({ role: "assistant", content: apiResult.content });
          // 只保留最近 20 条
          if (history.length > 20) {
            history.splice(0, history.length - 20);
          }
          await kv.put(historyKey, JSON.stringify(history));
        }
        return { ok: true };
      });
    }

    // Step 4: 返回结果
    return {
      content: apiResult.content,
      model: apiResult.model,
      sessionId: apiResult.sessionId,
      requestId: apiResult.requestId,
      steps: ["validate", "call api", "save history"],
    } satisfies ReplyResult;
  }
}