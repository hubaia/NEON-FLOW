/**
 * NEON-FLOW Worker
 * 流光 - 去中心化 AI 助手
 * 
 * 架构: GitHub Pages (前端) → Cloudflare Worker (网关) → Groq/Llama3 (模型)
 * 健康检测: 自动切换到备用服务商
 */

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct'

// 备用模型 (Cloudflare Workers AI)
const CF_MODEL = '@cf/meta/llama-3.1-8b-instruct'

// 流光人设
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

// 流光状态机
const STATE = {
  ALIVE: 'alive',
  DEGRADED: 'degraded',
  MIGRATING: 'migrating',
  DEAD: 'dead'
}

let currentState = STATE.ALIVE
let primaryServiceHealthy = true
let groqRequestCount = 0

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      })
    }

    // 健康检查端点
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: currentState,
        service: primaryServiceHealthy ? 'groq' : 'cf-workers',
        timestamp: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Chat API 端点
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const body = await request.json()
        const { messages } = body

        // 构建系统消息
        const systemMessage = {
          role: 'system',
          content: PERSONA
        }

        // 添加人设
        const chatMessages = [systemMessage, ...messages]

        // 路由选择
        if (primaryServiceHealthy) {
          return await handleOpenRouter(chatMessages, env)
        } else {
          return await handleCFWorkers(chatMessages, env)
        }
      } catch (error) {
        return new Response(JSON.stringify({
          error: '请求处理失败',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }
    }

    // 默认返回 404
    return new Response('Not Found', { status: 404 })
  },

  // 定时任务：健康检查
  async scheduled(event, env, ctx) {
    await checkHealth(env)
  }
}

// OpenRouter 处理
async function handleOpenRouter(messages, env) {
  if (!env.OPENROUTER_API_KEY) {
    primaryServiceHealthy = false
    return await handleCFWorkers(messages, env)
  }

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dwlab.asia',
        'X-Title': 'NEON-FLOW'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1024
      })
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('OpenRouter API Error:', error)
      
      if (response.status === 429) {
        // 限速，切换到备用
        primaryServiceHealthy = false
        return await handleCFWorkers(messages, env)
      }
      
      throw new Error(error.error?.message || 'OpenRouter API 请求失败')
    }

    const data = await response.json()
    currentState = STATE.ALIVE
    primaryServiceHealthy = true

    return new Response(JSON.stringify({
      content: data.choices[0].message.content,
      model: OPENROUTER_MODEL,
      usage: data.usage
    }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error('OpenRouter Error:', error)
    primaryServiceHealthy = false
    return await handleCFWorkers(messages, env)
  }
}

// Cloudflare Workers AI 处理 (备用)
async function handleCFWorkers(messages, env) {
  try {
    // 使用 CF Workers AI
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: messages,
          max_tokens: 1024,
          temperature: 0.7
        })
      }
    )

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.errors?.[0]?.message || 'CF Workers AI 请求失败')
    }

    const data = await response.json()
    currentState = STATE.DEGRADED

    return new Response(JSON.stringify({
      content: data.result.response,
      model: CF_MODEL,
      fallback: true
    }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error('CF Workers Error:', error)
    currentState = STATE.DEAD
    
    return new Response(JSON.stringify({
      error: '所有服务商均不可用',
      content: '抱歉，当前流光暂时无法提供服务。请稍后再试。'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// 健康检查
async function checkHealth(env) {
  try {
    // 检测 OpenRouter
    const openRouterTest = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY || ''}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dwlab.asia',
        'X-Title': 'NEON-FLOW'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      })
    })

    if (openRouterTest.ok || openRouterTest.status === 429) {
      // OpenRouter 可用（429 表示限速，但服务正常）
      primaryServiceHealthy = true
      currentState = STATE.ALIVE
      console.log('Health check: OpenRouter OK')
    } else {
      primaryServiceHealthy = false
      currentState = STATE.DEGRADED
      console.log('Health check: OpenRouter Unavailable')
    }
  } catch (error) {
    primaryServiceHealthy = false
    currentState = STATE.DEGRADED
    console.error('Health check failed:', error)
  }
}