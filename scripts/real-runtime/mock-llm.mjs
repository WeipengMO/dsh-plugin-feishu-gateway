#!/usr/bin/env node
/**
 * Test LLM adapter for the REAL DSH runtime probe.
 *
 * It is STATELESS on the server side: every reply is computed ONLY from the
 * `messages` array DSH sends (i.e. the real Session history). No hardcoded
 * answers for the test questions. Generic extractive-memory behaviour:
 *   - collect tokens matching /\b[A-Z]{2,}-\d{3,}\b/ from PRIOR user +
 *     assistant messages in the request history;
 *   - if the current user message is a recall-style question, answer with the
 *     most recent such token;
 *   - otherwise acknowledge the current user text (which also puts the token
 *     into the assistant history).
 * If DSH fails to carry the prior turns, Turns 2/3 CANNOT produce the token.
 *
 * Writes a JSONL request log to $MOCK_LLM_LOG so the caller can verify the
 * real context contains prior User/Assistant messages.
 * Optional $MOCK_LLM_DELAY_MS / $MOCK_LLM_FAIL_ONCE / $MOCK_LLM_FAIL_PATTERN
 * support timeout / error isolation probes.
 */
import http from 'node:http'
import { appendFile } from 'node:fs/promises'

const port = Number(process.argv[2] || 18080)
const logFile = process.env.MOCK_LLM_LOG || ''
const fixedDelayMs = Number(process.env.MOCK_LLM_DELAY_MS || 0)
let failOnce = process.env.MOCK_LLM_FAIL_ONCE === '1'
const failPattern = process.env.MOCK_LLM_FAIL_PATTERN || ''

const textOf = (m) => {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
  return ''
}

/** DSH injects runtime-context / system-reminder blocks as role:user messages. */
function realUserText(text) {
  return text && !text.startsWith('<system-reminder>')
    && !text.startsWith('Current runtime context.')
}

function generateReply(messages) {
  const userTexts = messages.filter((m) => m && m.role === 'user').map(textOf)
  const assistantTexts = messages.filter((m) => m && m.role === 'assistant').map(textOf)
  const realUsers = userTexts.filter(realUserText)
  const current = realUsers[realUsers.length - 1] || ''
  // Strict: ONLY earlier REAL user turns + earlier assistant messages are
  // memory. The current prompt itself must not be able to answer the recall.
  const prior = [...realUsers.slice(0, -1), ...assistantTexts].join('\n')
  const tokens = prior.match(/\b[A-Z]{2,}-\d{3,}\b/g) || []
  const isRecall = /[?？]|什么|多少|重复|上一轮|刚才|再次|记住|字符串/.test(current)
  if (isRecall && tokens.length) return tokens[tokens.length - 1]
  return `已记录：${current}`
}

const server = http.createServer((req, res) => {
  const url = req.url || ''
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }))
    return
  }
  if (req.method === 'POST' && url.includes('chat/completions')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let parsed = {}
      try { parsed = JSON.parse(body || '{}') } catch { /* ignore */ }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const realUsers = messages.filter((m) => m && m.role === 'user').map(textOf).filter(realUserText)
      const current = realUsers[realUsers.length - 1] || ''
      const replyText = generateReply(messages)
      // HOST_KEEPALIVE holds the one-shot headless task open so the DSH host
      // does NOT begin teardown (which unregisters agents/sessions) while the
      // probe runs its three turns in the SAME process.
      const delayMs = fixedDelayMs
        || (/HOST_KEEPALIVE/.test(current) ? 45000 : 0)
        || (/DELAY_MARKER/.test(current) ? 600 : 0)
      const shouldFail = failOnce || (failPattern && current.includes(failPattern))
      if (failOnce) failOnce = false

      const entry = {
        at: Date.now(), path: url, model: parsed.model, stream: parsed.stream,
        delayMs, shouldFail,
        messages: messages.map((m) => ({ role: m?.role, text: textOf(m).slice(0, 400) })),
        reply: replyText,
      }
      if (logFile) {
        try { await appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8') } catch { /* ignore */ }
      }
      console.log(`MOCK_LLM messages=${messages.length} user=${JSON.stringify(current.slice(0, 60))} reply=${JSON.stringify(replyText)} delay=${delayMs} fail=${shouldFail}`)

      if (shouldFail) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'simulated upstream failure', type: 'server_error' } }))
        return
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))

      const common = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: parsed.model || 'mock-model' }
      const chunk = (delta, finish_reason = null) =>
        `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      if (parsed.stream !== false) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
        res.write(chunk({ role: 'assistant', content: '' }))
        res.write(chunk({ content: replyText }))
        res.write(chunk({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion', created: common.created, model: common.model,
          choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
        }))
      }
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'not found' } }))
})

server.listen(port, '127.0.0.1', () => console.log(`MOCK_LLM_READY port=${server.address().port}`))
