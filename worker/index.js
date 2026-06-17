/**
 * NEON-FLOW Worker v5.0
 * 流光 - 去中心化 AI 助手
 * 
 * 架构: GitHub Pages (前端) → Cloudflare Worker (网关) → 多模型路由
 * 路由: OpenRouter免费模型(主) → Gemini(备用) → SiliconFlow(备用) → CF Workers AI(兜底)
 * 
 * v5.0 重构:
 * - 模型冷却状态持久化到 KV（Worker 重启不丢）
 * - 统计数据持久化到 KV（定时持久化 + 重启恢复）
 * - 修复未声明变量 groqServiceHealthy → primaryServiceHealthy
 * - API 错误信息中文优化
 * - 代码结构化拆分
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

// Google Gemini (备用)
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODELS = ['gemini-2.0-flash']

// SiliconFlow (备用)
const SILICON_API_URL = 'https://api.siliconflow.cn/v1/chat/completions'
const SILICON_MODELS = []  // 填入免费模型 ID 后启用

const REQUEST_TIMEOUT = 15000
const COOLDOWN_MS = 5 * 60 * 1000 // 5分钟冷却
const MAX_HISTORY = 20
const now = () => Date.now()

// ============ KV Keys ============
const KV_KEY_MODEL_STATUS = 'neon:model_status'
const KV_KEY_STATS = 'neon:stats'
const KV_KEY_STATE = 'neon:state'
const KV_KEY_PRIMARY = 'neon:primary'

// ============ In-Memory Cache (KV 读取后缓存) ============
let cachedModelStatus = null
let cachedStats = null
let lastCacheLoad = 0
const CACHE_TTL = 30_000 // 30秒缓存刷新间隔

// ============ 内存状态（首次请求后从 KV 恢复） ============
let currentState = 'alive'
let primaryServiceHealthy = false
let stats = {
  requests: 0, groqRequests: 0, orRequests: 0, googleRequests: 0, siliconRequests: 0, cfRequests: 0,
  groqSuccess: 0, orSuccess: 0, googleSuccess: 0, siliconSuccess: 0, cfSuccess: 0,
  startedAt: now()
}

// ============ 模型状态默认值 ============
function defaultModelStatus(models) {
  return Object.fromEntries(models.map(m => [m, {
    healthy: true, lastError: null, cooldownUntil: 0, failCount: 0, successCount: 0
  }]))
}

let modelStatus = defaultModelStatus(OPENROUTER_FREE_MODELS)
let geminiStatus = defaultModelStatus(GEMINI_MODELS)
let siliconStatus = defaultModelStatus(SILICON_MODELS)

// ============ KV 持久化 ============

async function loadStateFromKV(env) {
  if (!env.CHAT_HISTORY) return
  
  try {
    const [modelRaw, statsRaw, stateRaw, primaryRaw] = await Promise.all([
      env.CHAT_HISTORY.get(KV_KEY_MODEL_STATUS),
      env.CHAT_HISTORY.get(KV_KEY_STATS),
      env.CHAT_HISTORY.get(KV_KEY_STATE),
      env.CHAT_HISTORY.get(KV_KEY_PRIMARY)
    ])

    if (modelRaw) {
      const saved = JSON.parse(modelRaw)
      // 合并：保留默认结构，用 KV 的值覆盖
      for (const m of OPENROUTER_FREE_MODELS) {
        if (saved[m]) modelStatus[m] = { ...modelStatus[m], ...saved[m] }
      }
      for (const m of GEMINI_MODELS) {
        if (saved[m]) geminiStatus[m] = { ...geminiStatus[m], ...saved[m] }
      }
      for (const m of SILICON_MODELS) {
        if (saved[m]) siliconStatus[m] = { ...siliconStatus[m], ...saved[m] }
      }
    }

    if (statsRaw) {
      const saved = JSON.parse(statsRaw)
      stats = { ...stats, ...saved, startedAt: now() }
    }

    if (stateRaw) currentState = stateRaw
    if (primaryRaw) primaryServiceHealthy = primaryRaw === 'true'

    console.log(`[${ts()}] State restored from KV`)
  } catch (error) {
    console.error(`[${ts()}] KV restore failed:`, error.message)
  }
}

async function persistStateToKV(env) {
  if (!env.CHAT_HISTORY) return

  try {
    // 合并所有模型状态到一个对象
    const allStatus = { ...modelStatus, ...geminiStatus, ...siliconStatus }
    await Promise.all([
      env.CHAT_HISTORY.put(KV_KEY_MODEL_STATUS, JSON.stringify(allStatus), { expirationTtl: 86400 }),
      env.CHAT_HISTORY.put(KV_KEY_STATS, JSON.stringify(stats), { expirationTtl: 86400 }),
      env.CHAT_HISTORY.put(KV_KEY_STATE, currentState, { expirationTtl: 86400 }),
      env.CHAT_HISTORY.put(KV_KEY_PRIMARY, String(primaryServiceHealthy), { expirationTtl: 86400 })
    ])
  } catch (error) {
    console.error(`[${ts()}] KV persist failed:`, error.message)
  }
}

// 确保状态已从 KV 恢复（懒加载，只读一次）
async function ensureStateLoaded(env) {
  if (!cachedModelStatus) {
    await loadStateFromKV(env)
    cachedModelStatus = true
  }
}

// ============ 工具函数 ============

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

function genReqId() {
  return `neon-${now()}-${Math.random().toString(36).slice(2, 6)}`
}

function genSessionId() {
  return `sess-${now()}-${Math.random().toString(36).slice(2, 10)}`
}

function ts() {
  return new Date().toISOString()
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

function getAvailableModels(excludeCooldown = true) {
  return OPENROUTER_FREE_MODELS.filter(m => {
    const s = modelStatus[m]
    if (!excludeCooldown) return true
    return now() > s.cooldownUntil
  })
}

// 中文化错误信息
function translateError(errMsg, provider) {
  if (!errMsg) return '未知错误'
  const lower = errMsg.toLowerCase()
  if (lower.includes('rate limit') || lower.includes('429')) return `${provider} 请求频率超限，请稍后再试`
  if (lower.includes('timeout') || lower.includes('abort')) return `${provider} 请求超时`
  if (lower.includes('503') || lower.includes('unavailable')) return `${provider} 服务暂时不可用`
  if (lower.includes('500') || lower.includes('internal')) return `${provider} 服务器内部错误`
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('403')) return `${provider} 认证失败，请检查 API Key`
  if (lower.includes('402') || lower.includes('insufficient')) return `${provider} 额度不足`
  return `${provider} 请求失败：${errMsg}`
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
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY)
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

// ============ 模型调用 ============

function makeSuccessResponse(content, model, reqId, extra = {}) {
  return new Response(JSON.stringify({
    content, model, requestId: reqId, ...extra
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
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
      console.warn(`[${reqId}] Groq 频率超限，切换备用`)
      primaryServiceHealthy = false
      stats.groqRequests--
      return await handleOpenRouterFallback(messages, reqId, env)
    }

    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)

    currentState = STATE.ALIVE
    primaryServiceHealthy = true
    stats.groqSuccess++
    return makeSuccessResponse(data.choices[0].message.content, GROQ_MODEL, reqId, { usage: data.usage })
  } catch (error) {
    console.error(`[${reqId}] Groq 失败:`, error.message)
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
        const shortName = model.split('/')[1]?.split(':')[0] || model
        console.warn(`[${reqId}] ${shortName} 频率超限，冷却 5 分钟`)
        status.healthy = false
        status.cooldownUntil = now() + COOLDOWN_MS
        status.failCount++
        status.lastError = translateError(`HTTP ${response.status}`, 'OpenRouter')
        stats.orRequests--
        continue
      }

      const data = await response.json()

      if (!response.ok) {
        const errMsg = data.error?.message || `HTTP ${response.status}`
        if (response.status >= 500 || response.status === 403) {
          status.healthy = false
          status.cooldownUntil = now() + COOLDOWN_MS
        }
        status.lastError = translateError(errMsg, 'OpenRouter')
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
      return makeSuccessResponse(data.choices[0].message.content, model, reqId, { fallback: true })
    } catch (error) {
      console.error(`[${reqId}] OpenRouter ${model} 错误:`, error.message)
      status.healthy = false
      status.cooldownUntil = now() + COOLDOWN_MS
      status.lastError = translateError(error.message, 'OpenRouter')
      status.failCount++
      stats.orRequests--
    }
  }

  // 2. Google Gemini
  const { GEMINI_API_KEY } = env
  if (GEMINI_API_KEY) {
    const geminiResult = await handleGoogleGemini(messages, reqId, GEMINI_API_KEY)
    if (geminiResult) return geminiResult
  }

  // 3. SiliconFlow
  const { SILICON_API_KEY } = env
  if (SILICON_API_KEY) {
    const siliconResult = await handleSiliconFlow(messages, reqId, SILICON_API_KEY)
    if (siliconResult) return siliconResult
  }

  // 4. CF Workers AI
  return await handleCFFallback(messages, reqId, CF_ACCOUNT_ID, CF_API_TOKEN)
}

// Google Gemini
async function handleGoogleGemini(messages, reqId, apiKey) {
  if (!apiKey || !GEMINI_MODELS.length) return null

  for (const model of GEMINI_MODELS) {
    const status = geminiStatus[model]
    stats.googleRequests++

    try {
      const response = await fetchWithTimeout(
        `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
            generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
          })
        }
      )

      if (response.status === 429 || response.status === 503) {
        status.healthy = false
        status.cooldownUntil = now() + COOLDOWN_MS
        status.lastError = translateError(`HTTP ${response.status}`, 'Gemini')
        stats.googleRequests--
        continue
      }

      const data = await response.json()
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)

      status.healthy = true
      status.lastError = null
      status.cooldownUntil = 0
      status.successCount++
      currentState = STATE.DEGRADED
      stats.googleSuccess++
      return makeSuccessResponse(
        data.candidates?.[0]?.content?.parts?.[0]?.text || '',
        `gemini/${model}`, reqId, { fallback: true }
      )
    } catch (error) {
      status.healthy = false
      status.cooldownUntil = now() + COOLDOWN_MS
      status.lastError = translateError(error.message, 'Gemini')
      status.failCount++
      stats.googleRequests--
    }
  }
  return null
}

// SiliconFlow
async function handleSiliconFlow(messages, reqId, apiKey) {
  if (!apiKey || !SILICON_MODELS.length) return null

  for (const model of SILICON_MODELS) {
    const status = siliconStatus[model]
    stats.siliconRequests++

    try {
      const response = await fetchWithTimeout(SILICON_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1024 })
      })

      if (response.status === 429 || response.status === 503) {
        status.healthy = false
        status.cooldownUntil = now() + COOLDOWN_MS
        status.lastError = translateError(`HTTP ${response.status}`, 'SiliconFlow')
        stats.siliconRequests--
        continue
      }

      const data = await response.json()
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)

      status.healthy = true
      status.lastError = null
      status.cooldownUntil = 0
      status.successCount++
      currentState = STATE.DEGRADED
      stats.siliconSuccess++
      return makeSuccessResponse(data.choices?.[0]?.message?.content || '', `silicon/${model}`, reqId, { fallback: true })
    } catch (error) {
      status.healthy = false
      status.cooldownUntil = now() + COOLDOWN_MS
      status.lastError = translateError(error.message, 'SiliconFlow')
      status.failCount++
      stats.siliconRequests--
    }
  }
  return null
}

// CF Workers AI
async function handleCFFallback(messages, reqId, CF_ACCOUNT_ID, CF_API_TOKEN) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    currentState = STATE.DEAD
    return jsonResponse({ error: '所有服务商均不可用', content: '抱歉，流光暂时无法提供服务。所有模型都在休息，请稍后再试。' }, 503)
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
    return makeSuccessResponse(data.result.response, CF_MODEL, reqId, { fallback: true })
  } catch (error) {
    console.error(`[${reqId}] CF Workers 失败:`, error.message)
    currentState = STATE.DEAD
    stats.cfRequests--
    return jsonResponse({ error: '所有服务商均不可用', content: '抱歉，流光暂时无法提供服务。所有模型都在休息，请稍后再试。' }, 503)
  }
}

// ============ 健康检查 ============

async function checkHealth(env) {
  const { GROQ_API_KEY, OPENROUTER_API_KEY } = env

  // 检查 Groq（备用，但不作为主用）
  if (GROQ_API_KEY) {
    try {
      const response = await fetchWithTimeout(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
      }, 10000)

      if (response.ok || response.status === 429) {
        // Groq 可用，但不切为主用——OpenRouter 免费池优先
        console.log(`[${ts()}] Health: Groq 可用（备用就绪）`)
      }
    } catch (error) {
      console.warn(`[${ts()}] Health: Groq 不可用:`, error.message)
    }
  }

  // 检查 OpenRouter 免费模型
  if (OPENROUTER_API_KEY) {
    for (const model of getAvailableModels(true)) {
      try {
        const response = await fetchWithTimeout(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://dwlab.asia',
            'X-Title': 'NEON-FLOW'
          },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
        }, 10000)

        if (response.ok || response.status === 429) {
          currentState = STATE.ALIVE
          console.log(`[${ts()}] Health: OpenRouter ${model.split('/')[1]} 正常`)
          // 持久化状态
          await persistStateToKV(env)
          return
        }

        modelStatus[model].healthy = false
        modelStatus[model].cooldownUntil = now() + COOLDOWN_MS
      } catch (error) {
        modelStatus[model].healthy = false
        modelStatus[model].cooldownUntil = now() + COOLDOWN_MS
      }
    }
  }

  currentState = STATE.DEAD
  console.log(`[${ts()}] Health: 所有服务不可用`)
  await persistStateToKV(env)
}

// ============ 请求路由 ============

function buildModelStatusResponse() {
  return {
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
    cf: { provider: 'CF Workers AI', model: CF_MODEL },
    google: {
      provider: 'Google Gemini',
      models: GEMINI_MODELS.map(m => ({
        id: m,
        healthy: geminiStatus[m].healthy,
        cooldown: geminiStatus[m].cooldownUntil > now(),
        cooldownRemaining: Math.max(0, Math.round((geminiStatus[m].cooldownUntil - now()) / 1000)),
        failCount: geminiStatus[m].failCount,
        successCount: geminiStatus[m].successCount,
        lastError: geminiStatus[m].lastError
      }))
    },
    silicon: {
      provider: 'SiliconFlow',
      models: SILICON_MODELS.map(m => ({
        id: m,
        healthy: siliconStatus[m].healthy,
        cooldown: siliconStatus[m].cooldownUntil > now(),
        cooldownRemaining: Math.max(0, Math.round((siliconStatus[m].cooldownUntil - now()) / 1000)),
        failCount: siliconStatus[m].failCount,
        successCount: siliconStatus[m].successCount,
        lastError: siliconStatus[m].lastError
      }))
    }
  }
}

// ============ Main Export ============

export default {
  async fetch(request, env) {
    // 确保从 KV 恢复状态
    await ensureStateLoaded(env)

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
        name: 'NEON-FLOW', version: '5.0', status: currentState,
        primary: primaryServiceHealthy ? 'groq' : 'openrouter (free)',
        endpoints: { chat: '/api/chat', health: '/health', models: '/models', stats: '/stats' }
      })
    }

    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({
        status: currentState,
        primary: primaryServiceHealthy ? 'groq' : 'openrouter (free)',
        uptimeSeconds: Math.round((now() - stats.startedAt) / 1000),
        timestamp: now()
      })
    }

    // 模型状态
    if (url.pathname === '/models') {
      return jsonResponse(buildModelStatusResponse())
    }

    // 统计
    if (url.pathname === '/stats') {
      const total = stats.orSuccess + stats.googleSuccess + stats.siliconSuccess + stats.cfSuccess
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
        return jsonResponse({ error: '请求体格式无效' }, 400)
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return jsonResponse({ error: '消息不能为空' }, 400)
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
        return jsonResponse({ error: '请求体格式无效' }, 400)
      }
      if (!sessionId) return jsonResponse({ error: '缺少 sessionId' }, 400)

      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.delete(`history:${sessionId}`)
        return jsonResponse({ ok: true, message: '对话历史已清除', sessionId })
      }
      return jsonResponse({ error: 'KV 未配置' }, 500)
    }

    // 读取历史
    if (url.pathname === '/api/history' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') || request.headers.get('X-Session-Id')
      if (!sessionId) return jsonResponse({ error: '缺少 sessionId' }, 400)

      if (env.CHAT_HISTORY) {
        const history = await getHistory(env, sessionId)
        return jsonResponse({ sessionId, history, count: history.length })
      }
      return jsonResponse({ error: 'KV 未配置' }, 500)
    }

    // 手动持久化（调试用）
    if (url.pathname === '/api/admin/persist' && request.method === 'POST') {
      await persistStateToKV(env)
      return jsonResponse({ ok: true, message: '状态已持久化' })
    }

    return jsonResponse({ error: '接口不存在' }, 404)
  },

  async scheduled(event, env) {
    await ensureStateLoaded(env)
    await checkHealth(env)
    // 定时持久化统计
    await persistStateToKV(env)
  }
}
