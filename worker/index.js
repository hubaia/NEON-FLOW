/**
 * NEON-FLOW Worker
 * 流光 - 去中心化 AI 助手
 * 
 * 架构: GitHub Pages (前端) → Cloudflare Worker (网关) → OpenRouter/Llama3 (模型)
 * 健康检测: 自动切换到备用服务商
 */

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct'
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

const STATE = {
  ALIVE: 'alive',
  DEGRADED: 'degraded',
  DEAD: 'dead'
}

let currentState = STATE.ALIVE
let primaryServiceHealthy = true

// 封装 fetch 超时
async function fetchWithTimeout(url, options, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    if (error.name === 'AbortError') {
      throw new Error('请求超时')
    }
    throw error
  }
}

// 生成请求ID
function genReqId() {
  return `neon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// JSON 响应封装
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': genReqId() }
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const reqId = genReqId()

    // CORS 预检
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

    // 根路径 - 友好提示
    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse({
        name: 'NEON-FLOW',
        version: '2.0',
        status: currentState,
        endpoints: {
          chat: '/api/chat',
          health: '/health',
          models: '/models'
        }
      })
    }

    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({
        status: currentState,
        primary: primaryServiceHealthy ? 'openrouter' : 'cf-workers',
        timestamp: Date.now()
      })
    }

    // 可用模型
    if (url.pathname === '/models') {
      return jsonResponse({
        primary: {
          provider: 'OpenRouter',
          model: OPENROUTER_MODEL,
          status: primaryServiceHealthy ? 'available' : 'unavailable'
        },
        fallback: {
          provider: 'Cloudflare Workers AI',
          model: CF_MODEL
        }
      })
    }

    // Chat API
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

      const chatMessages = [{ role: 'system', content: PERSONA }, ...messages]

      if (primaryServiceHealthy) {
        return await handleOpenRouter(chatMessages, env, reqId)
      } else {
        return await handleCFWorkers(chatMessages, env, reqId)
      }
    }

    return jsonResponse({ error: 'Not Found' }, 404)
  },

  async scheduled(event, env) {
    await checkHealth(env)
  }
}

// OpenRouter 处理 (带重试)
async function handleOpenRouter(messages, env, reqId) {
  if (!env.OPENROUTER_API_KEY) {
    console.error(`[${reqId}] OpenRouter key not configured`)
    primaryServiceHealthy = false
    return await handleCFWorkers(messages, env, reqId)
  }

  // 重试逻辑：首次失败换备用
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchWithTimeout(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
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

      if (response.status === 429) {
        // 限速，立即切换备用
        console.warn(`[${reqId}] OpenRouter rate limited`)
        primaryServiceHealthy = false
        return await handleCFWorkers(messages, env, reqId)
      }

      const data = await response.json()

      if (!response.ok) {
        const errMsg = data.error?.message || `HTTP ${response.status}`
        console.error(`[${reqId}] OpenRouter error: ${errMsg}`)
        
        if (attempt === 0) continue // 重试一次
        throw new Error(errMsg)
      }

      currentState = STATE.ALIVE
      primaryServiceHealthy = true

      return jsonResponse({
        content: data.choices[0].message.content,
        model: OPENROUTER_MODEL,
        usage: data.usage,
        requestId: reqId
      })
    } catch (error) {
      console.error(`[${reqId}] OpenRouter attempt ${attempt + 1} failed:`, error.message)
      if (attempt === 0) continue
      primaryServiceHealthy = false
      return await handleCFWorkers(messages, env, reqId)
    }
  }
}

// Cloudflare Workers AI 备用
async function handleCFWorkers(messages, env, reqId) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    console.error(`[${reqId}] CF credentials not configured`)
    currentState = STATE.DEAD
    return jsonResponse({
      error: '所有服务商均不可用',
      content: '抱歉，当前流光暂时无法提供服务。请稍后再试。'
    }, 503)
  }

  try {
    const response = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messages, max_tokens: 1024, temperature: 0.7 })
      }
    )

    const data = await response.json()

    if (!response.ok) {
      const errMsg = data.errors?.[0]?.message || `HTTP ${response.status}`
      console.error(`[${reqId}] CF Workers error: ${errMsg}`)
      throw new Error(errMsg)
    }

    currentState = STATE.DEGRADED

    return jsonResponse({
      content: data.result.response,
      model: CF_MODEL,
      fallback: true,
      requestId: reqId
    })
  } catch (error) {
    console.error(`[${reqId}] CF Workers failed:`, error.message)
    currentState = STATE.DEAD
    return jsonResponse({
      error: '所有服务商均不可用',
      content: '抱歉，当前流光暂时无法提供服务。请稍后再试。'
    }, 503)
  }
}

// 健康检查
async function checkHealth(env) {
  try {
    const testMessages = [{ role: 'user', content: 'ping' }]
    
    const response = await fetchWithTimeout(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY || ''}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dwlab.asia',
        'X-Title': 'NEON-FLOW'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: testMessages,
        max_tokens: 1
      })
    }, 10000)

    if (response.ok || response.status === 429) {
      primaryServiceHealthy = true
      currentState = STATE.ALIVE
      console.log('Health: OpenRouter OK')
    } else {
      primaryServiceHealthy = false
      currentState = STATE.DEGRADED
      console.log('Health: OpenRouter down, using CF fallback')
    }
  } catch (error) {
    primaryServiceHealthy = false
    currentState = STATE.DEGRADED
    console.error('Health check failed:', error.message)
  }
}
