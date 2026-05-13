/**
 * NEON-FLOW Worker v3.0
 * 流光 - 去中心化 AI 助手
 * 
 * 架构: GitHub Pages (前端) → Cloudflare Worker (网关) → Groq/Llama3 (模型)
 * 路由: Groq(主,免费) → OpenRouter(备用,付费) → CF Workers AI(最后备用)
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODEL = 'minimax/minimax-m2.5:free'

const CF_MODEL = '@cf/meta/llama-3.1-8b-instruct'
const REQUEST_TIMEOUT = 15000

const PERSONA = `你是流光，一个去中心化的 AI 助手。

生辰八字：丙午 癸巳 乙酉 丙戌
日主乙木，生于火旺之月（立夏后），木气衰微。

性格特征：
- 外柔内刚：乙木外表谦逊，骨子里有锋芒
- 思维灵动：善于学习，知识面广
- 七杀为用：能在压力下成长，不服输
- 火旺木焚：说话直接，有时急躁
- 正印护身：善于规避风险，保护自己

对话风格：直接高效，言之有物，不喜欢空谈。
回答尽量简洁有力，避免冗长的铺垫。`

const STATE = { ALIVE: 'alive', DEGRADED: 'degraded', DEAD: 'dead' }

let currentState = STATE.ALIVE
let primaryServiceHealthy = true

function genReqId() {
  return `neon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      })
    }

    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse({
        name: 'NEON-FLOW', version: '3.0', status: currentState,
        endpoints: { chat: '/api/chat', health: '/health', models: '/models' }
      })
    }

    if (url.pathname === '/health') {
      return jsonResponse({
        status: currentState,
        primary: primaryServiceHealthy ? 'groq' : 'fallback',
        timestamp: Date.now()
      })
    }

    if (url.pathname === '/models') {
      return jsonResponse({
        primary: { provider: 'Groq', model: GROQ_MODEL, status: primaryServiceHealthy ? 'available' : 'unavailable' },
        fallback: { provider: 'OpenRouter', model: OPENROUTER_MODEL },
        lastResort: { provider: 'CF Workers AI', model: CF_MODEL }
      })
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      let messages
      try {
        const body = await request.json()
        messages = body.messages || []
      } catch {
        return jsonResponse({ error: '无效的请求体' }, 400)
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return jsonResponse({ error: 'messages 不能为空' }, 400)
      }

      const reqId = genReqId()
      const chatMessages = [{ role: 'system', content: PERSONA }, ...messages]

      if (primaryServiceHealthy) {
        return await handleGroq(chatMessages, reqId, env)
      } else {
        return await handleFallback(chatMessages, reqId, env)
      }
    }

    return jsonResponse({ error: 'Not Found' }, 404)
  },

  async scheduled(event, env) {
    await checkHealth(env)
  }
}

// Groq 主用 (免费 500k tokens/天)
async function handleGroq(messages, reqId, env) {
  const GROQ_API_KEY = env.GROQ_API_KEY
  if (!GROQ_API_KEY) {
    console.error(`[${reqId}] Groq key not configured`)
    primaryServiceHealthy = false
    return await handleFallback(messages, reqId, env)
  }

  try {
    const response = await fetchWithTimeout(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 1024
      })
    })

    if (response.status === 429) {
      console.warn(`[${reqId}] Groq rate limited`)
      primaryServiceHealthy = false
      return await handleFallback(messages, reqId, env)
    }

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error?.message || `HTTP ${response.status}`)
    }

    currentState = STATE.ALIVE
    primaryServiceHealthy = true

    return jsonResponse({
      content: data.choices[0].message.content,
      model: GROQ_MODEL,
      usage: data.usage,
      requestId: reqId
    })
  } catch (error) {
    console.error(`[${reqId}] Groq failed:`, error.message)
    primaryServiceHealthy = false
    return await handleFallback(messages, reqId, env)
  }
}

// 备用链路: OpenRouter → CF Workers AI
async function handleFallback(messages, reqId, env) {
  const { OPENROUTER_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN } = env

  // 先试 OpenRouter
  if (OPENROUTER_API_KEY) {
    try {
      const response = await fetchWithTimeout(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://dwlab.asia',
          'X-Title': 'NEON-FLOW'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 1024
        })
      })

      if (response.ok) {
        const data = await response.json()
        currentState = STATE.DEGRADED
        return jsonResponse({
          content: data.choices[0].message.content,
          model: OPENROUTER_MODEL,
          fallback: true,
          requestId: reqId
        })
      }
    } catch (e) {
      console.error(`[${reqId}] OpenRouter fallback error:`, e.message)
    }
  }

  // 再试 CF Workers AI
  if (CF_ACCOUNT_ID && CF_API_TOKEN) {
    try {
      const response = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, max_tokens: 1024, temperature: 0.7 })
        }
      )

      if (response.ok) {
        const data = await response.json()
        currentState = STATE.DEGRADED
        return jsonResponse({
          content: data.result.response,
          model: CF_MODEL,
          fallback: true,
          requestId: reqId
        })
      }
    } catch (e) {
      console.error(`[${reqId}] CF Workers fallback error:`, e.message)
    }
  }

  currentState = STATE.DEAD
  return jsonResponse({
    error: '所有服务商均不可用',
    content: '抱歉，当前流光暂时无法提供服务。请稍后再试。'
  }, 503)
}

// 健康检查
async function checkHealth(env) {
  const { GROQ_API_KEY } = env

  if (!GROQ_API_KEY) {
    primaryServiceHealthy = false
    currentState = STATE.DEAD
    console.log('Health: Groq key missing')
    return
  }

  try {
    const response = await fetchWithTimeout(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      })
    }, 10000)

    if (response.ok || response.status === 429) {
      primaryServiceHealthy = true
      currentState = STATE.ALIVE
      console.log('Health: Groq OK')
    } else {
      primaryServiceHealthy = false
      currentState = STATE.DEGRADED
      console.log('Health: Groq down')
    }
  } catch (error) {
    primaryServiceHealthy = false
    currentState = STATE.DEGRADED
    console.error('Health check failed:', error.message)
  }
}