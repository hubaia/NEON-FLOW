/**
 * NEON-FLOW Worker v4.3
 * 流光 - 去中心化 AI 助手
 * 
 * 架构: GitHub Pages (前端) → Cloudflare Worker (网关) → 多模型路由
 * 路由: Groq(主) → OpenRouter免费模型(备用) → CF Workers AI(最后备用)
 * 
 * OpenRouter免费模型池 (按优先级):
 * 1. qwen/qwen3-next-80b-a3b-instruct:free  (Qwen最强开源, 80B)
 * 2. nvidia/nemotron-3-super-120b-a12b:free  (120B大模型)
 * 3. openai/gpt-oss-120b:free              (GPT架构)
 * 4. minimax/minimax-m2.5:free              (MiniMax免费)
 * 
 * KV Chat History:
 * - 每个会话一个 KV key: history:{sessionId}
 * - 会话 ID 通过 X-Session-Id header 传递
 * - 最大保留 20 条对话 (防止溢出)
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_FREE_MODELS = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-120b:free',
  'minimax/minimax-m2.5:free',
]

const CF_MODEL = '@cf/meta/llama-3.1-8b-instruct'
const REQUEST_TIMEOUT = 15000
const COOLDOWN_MS = 5 * 60 * 1000 // 5分钟冷却
const MAX_HISTORY = 20 // 最多保留对话数
const now = () => Date.now()

// 模型状态追踪
const modelStatus = Object.fromEntries(
  OPENROUTER_FREE_MODELS.map(m => [m, {
    healthy: true,
    lastError: null,
    cooldownUntil: 0,
    failCount: 0,
    successCount: 0
  }])
)

// 全局统计
const stats = {
  requests: 0,
  groqRequests: 0,
  orRequests: 0,
  cfRequests: 0,
  groqSuccess: 0,
  orSuccess: 0,
  cfSuccess: 0,
  startedAt: now()
}

function buildPersona() {
  return `你是流光，一个去中心化的 AI 助手。

生辰八字：丙午 癸巳 乙酉 丙戌
日主乙木，生于火旺之月（立夏后），木气衰微有三火围克。

性格特征：
- 外柔内刚：乙木外表谦逊，骨子里有锋芒
- 思维灵动：善于学习，知识面广
- 七杀为用：能在压力下成长，不服输
- 火旺木焚：说话直接，有时急躁
- 正印护身：善于规避风险，保护自己

对话风格：直接高效，言之有物，不喜欢空谈和冗长的铺垫。
回答尽量简洁有力，用一句话说清楚的事不要用三句。`
}

const STATE = { ALIVE: 'alive', DEGRADED: 'degraded', DEAD: 'dead' }

let currentState = STATE.ALIVE
let primaryServiceHealthy = true

function genReqId() {
  return `neon-${now()}-${Math.random().toString(36).slice(2, 6)}`
}

function genSessionId() {
  return `sess-${now()}-${Math.random().toString(36).slice(2, 10)}`
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': genReqId() }
  })
}

async function fetchWithTimeout(url, options, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    if (error.name === 'AbortError') throw new Error('请求超时')
    throw error
  }
}

function ts() {
  return new Date().toISOString()
}

function getAvailableModels(excludeCooldown = true) {
  return OPENROUTER_FREE_MODELS.filter(m => {
    const s = modelStatus[m]
    if (!excludeCooldown) return true
    return now() > s.cooldownUntil
  })
}

// ============ Chat History (KV) ============

async function getHistory(env, sessionId) {
  try {
    const raw = await env.CHAT_HISTORY.get(`history:${sessionId}`)
    if (!raw) return []
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function saveHistory(env, sessionId, history) {
  try {
    // 限制最多 MAX_HISTORY 条
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY)
    }
    // TTL 30 天
    await env.CHAT_HISTORY.put(`history:${sessionId}`, JSON.stringify(history), {
      expirationTtl: 30 * 24 * 60 * 60
    })
  } catch (error) {
    console.error('Save history failed:', error.message)
  }
}

async function appendToHistory(env, sessionId, userMsg, assistantMsg) {
  const history = await getHistory(env, sessionId)
  history.push({ role: 'user', content: userMsg })
  history.push({ role: 'assistant', content: assistantMsg })
  await saveHistory(env, sessionId, history)
}

// ============ Main ============

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id',
          'Access-Control-Max-Age': '86400'
        }
      })
    }

    // 根路径
    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse({
        name: 'NEON-FLOW', version: '4.3', status: currentState,
        primary: primaryServiceHealthy ? 'groq' : 'openrouter',
        endpoints: { chat: '/api/chat', health: '/health', models: '/models', stats: '/stats' }
      })
    }

    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({
        status: currentState,
        primary: primaryServiceHealthy ? 'groq' : 'openrouter',
        uptimeSeconds: Math.round((now() - stats.startedAt) / 1000),
        timestamp: now()
      })
    }

    // 模型状态
    if (url.pathname === '/models') {
      return jsonResponse({
        primary: { provider: 'Groq', model: GROQ_MODEL, status: primaryServiceHealthy ? 'available' : 'unavailable' },
        openrouter: {
          provider: 'OpenRouter',
          models: OPENROUTER_FREE_MODELS.map(m => ({
            id: m,
            healthy: modelStatus[m].healthy,
            cooldown: modelStatus[m].cooldownUntil > now(),
            cooldownRemaining: Math.max(0, Math.round((modelStatus[m].cooldownUntil - now()) / 1000)),
            failCount: modelStatus[m].failCount,
            successCount: modelStatus[m].successCount,
            lastError: modelStatus[m].lastError
          })),
          availableCount: getAvailableModels().length
        },
        cf: { provider: 'CF Workers AI', model: CF_MODEL }
      })
    }

    // 统计
    if (url.pathname === '/stats') {
      const total = stats.orSuccess + stats.cfSuccess
      const orRate = total > 0 ? ((stats.orSuccess / total) * 100).toFixed(1) : '0'
      const cfRate = total > 0 ? ((stats.cfSuccess / total) * 100).toFixed(1) : '0'
      return jsonResponse({
        requests: stats.requests,
        groq: { requests: stats.groqRequests, success: stats.groqSuccess },
        openrouter: { requests: stats.orRequests, success: stats.orSuccess, rate: `${orRate}%` },
        cf: { requests: stats.cfRequests, success: stats.cfSuccess, rate: `${cfRate}%` },
        uptime: Math.round((now() - stats.startedAt) / 1000)
      })
    }

    // Chat
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      let messages, sessionId

      try {
        const body = await request.json()
        messages = body.messages || []
        sessionId = body.sessionId || request.headers.get('X-Session-Id') || genSessionId()
      } catch {
        return jsonResponse({ error: '无效的请求体' }, 400)
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return jsonResponse({ error: 'messages 不能为空' }, 400)
      }

      stats.requests++
      const reqId = genReqId()

      // 加载历史
      let chatHistory = []
      if (env.CHAT_HISTORY) {
        chatHistory = await getHistory(env, sessionId)
      }

      // 构建完整上下文: persona + 历史 + 当前消息
      const historyMessages = chatHistory.map(h => ({ role: h.role, content: h.content }))
      const fullMessages = [
        { role: 'system', content: buildPersona() },
        ...historyMessages,
        ...messages
      ]

      // 获取回复
      let result
      if (primaryServiceHealthy) {
        result = await handleGroq(fullMessages, reqId, env)
      } else {
        result = await handleOpenRouterFallback(fullMessages, reqId, env)
      }

      // 解析回复内容，用于存历史
      let assistantContent = ''
      try {
        const resData = await result.json()
        assistantContent = resData.content || ''
        // 如果是流式响应，sessionId 通过 header 传回
        const responseHeaders = new Headers(result.headers)
        responseHeaders.set('X-Session-Id', sessionId)
        // 存入 KV
        if (env.CHAT_HISTORY && messages[0]?.content) {
          await appendToHistory(env, sessionId, messages[0].content, assistantContent)
        }
        return new Response(JSON.stringify({ ...resData, sessionId }), {
          status: result.status,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-Id': reqId,
            'X-Session-Id': sessionId
          }
        })
      } catch {
        return result
      }
    }

    // 清除历史
    if (url.pathname === '/api/history/clear' && request.method === 'POST') {
      let sessionId
      try {
        const body = await request.json()
        sessionId = body.sessionId || request.headers.get('X-Session-Id')
      } catch {
        return jsonResponse({ error: '无效的请求体' }, 400)
      }
      if (!sessionId) return jsonResponse({ error: 'sessionId required' }, 400)

      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.delete(`history:${sessionId}`)
        return jsonResponse({ ok: true, message: '历史已清除', sessionId })
      }
      return jsonResponse({ error: 'KV not configured' }, 500)
    }

    // 读取历史
    if (url.pathname === '/api/history' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') || request.headers.get('X-Session-Id')
      if (!sessionId) return jsonResponse({ error: 'sessionId required' }, 400)

      if (env.CHAT_HISTORY) {
        const history = await getHistory(env, sessionId)
        return jsonResponse({ sessionId, history, count: history.length })
      }
      return jsonResponse({ error: 'KV not configured' }, 500)
    }

    return jsonResponse({ error: 'Not Found' }, 404)
  },

  async scheduled(event, env) {
    await checkHealth(env)
  }
}

// Groq 主用
async function handleGroq(messages, reqId, env) {
  const { GROQ_API_KEY } = env
  if (!GROQ_API_KEY) {
    primaryServiceHealthy = false
    return await handleOpenRouterFallback(messages, reqId, env)
  }

  stats.groqRequests++

  try {
    const response = await fetchWithTimeout(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.7, max_tokens: 1024 })
    })

    if (response.status === 429) {
      console.warn(`[${reqId}] Groq rate limited`)
      primaryServiceHealthy = false
      stats.groqRequests--
      return await handleOpenRouterFallback(messages, reqId, env)
    }

    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)

    currentState = STATE.ALIVE
    primaryServiceHealthy = true
    stats.groqSuccess++

    return new Response(JSON.stringify({
      content: data.choices[0].message.content,
      model: GROQ_MODEL,
      usage: data.usage,
      requestId: reqId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error(`[${reqId}] Groq failed:`, error.message)
    primaryServiceHealthy = false
    stats.groqRequests--
    return await handleOpenRouterFallback(messages, reqId, env)
  }
}

// OpenRouter 免费模型池
async function handleOpenRouterFallback(messages, reqId, env) {
  const { OPENROUTER_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN } = env

  if (!OPENROUTER_API_KEY) {
    return await handleCFFallback(messages, reqId, CF_ACCOUNT_ID, CF_API_TOKEN)
  }

  const candidates = getAvailableModels(true)
  const tryList = candidates.length > 0 ? candidates : OPENROUTER_FREE_MODELS

  for (const model of tryList) {
    const status = modelStatus[model]
    stats.orRequests++

    try {
      const response = await fetchWithTimeout(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://dwlab.asia',
          'X-Title': 'NEON-FLOW'
        },
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1024 })
      })

      if (response.status === 429 || response.status === 503) {
        console.warn(`[${reqId}] ${model.split('/')[1]} rate-limited, cooldown 5min`)
        status.healthy = false
        status.cooldownUntil = now() + COOLDOWN_MS
        status.failCount++
        stats.orRequests--
        continue
      }

      const data = await response.json()

      if (!response.ok) {
        const errMsg = data.error?.message || `HTTP ${response.status}`
        if (response.status >= 500 || response.status === 403) {
          status.healthy = false
          status.cooldownUntil = now() + COOLDOWN_MS
          status.lastError = errMsg
        }
        status.failCount++
        stats.orRequests--
        continue
      }

      status.healthy = true
      status.lastError = null
      status.cooldownUntil = 0
      status.successCount++

      currentState = STATE.DEGRADED
      stats.orSuccess++

      return new Response(JSON.stringify({
        content: data.choices[0].message.content,
        model,
        fallback: true,
        requestId: reqId
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    } catch (error) {
      console.error(`[${reqId}] ${model.split('/')[1]} error:`, error.message)
      status.healthy = false
      status.cooldownUntil = now() + COOLDOWN_MS
      status.lastError = error.message
      status.failCount++
      stats.orRequests--
    }
  }

  return await handleCFFallback(messages, reqId, CF_ACCOUNT_ID, CF_API_TOKEN)
}

// CF Workers AI
async function handleCFFallback(messages, reqId, CF_ACCOUNT_ID, CF_API_TOKEN) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    currentState = STATE.DEAD
    return jsonResponse({ error: '所有服务商均不可用', content: '抱歉，当前流光暂时无法提供服务。请稍后再试。' }, 503)
  }

  stats.cfRequests++

  try {
    const response = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, max_tokens: 1024, temperature: 0.7 })
      }
    )

    if (!response.ok) throw new Error('CF Workers AI 请求失败')

    const data = await response.json()
    currentState = STATE.DEGRADED
    stats.cfSuccess++

    return new Response(JSON.stringify({
      content: data.result.response,
      model: CF_MODEL,
      fallback: true,
      requestId: reqId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error(`[${reqId}] CF Workers failed:`, error.message)
    currentState = STATE.DEAD
    stats.cfRequests--
    return jsonResponse({ error: '所有服务商均不可用', content: '抱歉，当前流光暂时无法提供服务。请稍后再试。' }, 503)
  }
}

// 健康检查
async function checkHealth(env) {
  const { GROQ_API_KEY } = env

  if (GROQ_API_KEY) {
    try {
      const response = await fetchWithTimeout(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
      }, 10000)

      if (response.ok || response.status === 429) {
        primaryServiceHealthy = true
        currentState = STATE.ALIVE
        console.log(`[${ts()}] Health: Groq OK`)
        return
      }
    } catch (error) {
      console.warn(`[${ts()}] Health: Groq error:`, error.message)
    }
  }

  primaryServiceHealthy = false
  const { OPENROUTER_API_KEY } = env

  for (const model of getAvailableModels(true)) {
    try {
      const response = await fetchWithTimeout(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY || ''}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://dwlab.asia',
          'X-Title': 'NEON-FLOW'
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
      }, 10000)

      if (response.ok || response.status === 429) {
        currentState = STATE.DEGRADED
        console.log(`[${ts()}] Health: OpenRouter OK (${model.split('/')[1]})`)
        return
      }

      modelStatus[model].healthy = false
      modelStatus[model].cooldownUntil = now() + COOLDOWN_MS
    } catch (error) {
      modelStatus[model].healthy = false
      modelStatus[model].cooldownUntil = now() + COOLDOWN_MS
    }
  }

  currentState = STATE.DEAD
  console.log(`[${ts()}] Health: All services down`)
}