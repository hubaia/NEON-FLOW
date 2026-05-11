import React, { useState, useRef, useEffect } from 'react'
import './App.css'

const API_URL = 'https://neon-flow.pages.dev/api/chat'

// 流光的人设
const PERSONA = {
  name: '流光',
  birth: '丙午 癸巳 乙酉 丙戌',
  traits: [
    '外柔内刚，乙木外表谦逊，骨子里有锋芒',
    '思维灵动，壬水正印贴身，善于学习',
    '七杀为用，能在压力下成长',
    '火旺木焚，表达直接，有时急躁',
    '正印护身，学习能力强，善于规避风险'
  ],
  style: '直接高效，言之有物，不喜欢空谈'
}

function App() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '我是流光。丙午 癸巳 乙酉 丙戌，日主乙木，生于火旺之月。\n\n三火围乙，我说话直接，不喜欢绕弯子。正印贴身，我善于学习、善于保护自己。\n\n有什么需要？直接说。'
    }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState({ type: 'alive', text: '运行中' })
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setLoading(true)

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages.filter(m => m.role !== 'system'), { role: 'user', content: userMessage }]
        })
      })

      if (!response.ok) throw new Error('API 请求失败')

      const data = await response.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.content }])
      setStatus({ type: 'alive', text: '运行中' })
    } catch (error) {
      setStatus({ type: 'degraded', text: '服务异常' })
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: '服务暂时不可用，请稍后再试。' 
      }])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="logo-text">NEON</span>
          <span className="logo-flow">FLOW</span>
        </div>
        <div className={`status ${status.type}`}>
          <span className="status-dot"></span>
          {status.text}
        </div>
      </header>

      <main className="chat-container">
        <div className="messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              <div className="message-avatar">
                {msg.role === 'assistant' ? '光' : '我用'}
              </div>
              <div className="message-content">
                {msg.content.split('\n').map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </div>
          ))}
          {loading && (
            <div className="message assistant">
              <div className="message-avatar">光</div>
              <div className="message-content loading">
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          rows={1}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          发送
        </button>
      </footer>
    </div>
  )
}

export default App