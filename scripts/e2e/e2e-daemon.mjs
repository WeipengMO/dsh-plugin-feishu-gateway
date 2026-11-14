/**
 * TEST-ONLY long-running Host for real-Feishu E2E.
 *
 * `dsh-headless` exits as soon as its one-shot task finishes
 * (`dsh-headless/lib/index.js:383` → `io.exit()`), which disposes the root fiber,
 * clears the agent factory and detaches Sessions. A real Feishu long connection
 * needs a process that stays alive while a human sends messages, so this profile
 * mounts `dsh-base` + the gateway plugin WITHOUT `dsh-headless`, and this plugin
 * keeps the process alive until SIGTERM/SIGINT.
 *
 * It exposes a tiny loopback HTTP control surface (no Feishu credentials):
 *   GET  /health    → gateway health + live counters
 *   GET  /messages  → outbound messages captured by the gateway (redacted view)
 *   POST /shutdown  → graceful stop (lets the caller assert clean teardown)
 *
 * Bound to 127.0.0.1 only.
 */
import http from 'node:http'

export const name = 'feishu-e2e-daemon'

export function apply(ctx, config) {
  const port = Number(config?.port ?? 18091)
  const startedAt = Date.now()
  const events = []
  let stopping = false

  const gateway = () => {
    try { return ctx.get('feishuGateway') } catch { return undefined }
  }

  // Record gateway lifecycle without ever touching message content beyond what
  // the caller explicitly asks for.
  const off = []
  try {
    off.push(ctx.on('session/event', (session, event) => {
      if (events.length < 200) events.push({ at: Date.now(), kind: 'session/event', sessionId: String(session?.id ?? ''), type: String(event?.type ?? '') })
    }))
  } catch { /* event may not exist in minimal profiles */ }

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0]
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url === '/health') {
      const gw = gateway()
      return json(200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        gatewayProvided: Boolean(gw),
        health: gw ? gw.health() : null,
        eventCount: events.length,
      })
    }
    if (req.method === 'GET' && url === '/events') {
      return json(200, { events })
    }
    if (req.method === 'GET' && url === '/diagnostics') {
      const gw = gateway()
      if (!gw) return json(503, { ok: false, error: 'feishuGateway service not provided' })
      Promise.resolve(gw.diagnostics()).then((d) => json(200, { ok: true, diagnostics: d })).catch((e) => json(500, { ok: false, error: String(e) }))
      return
    }
    if (req.method === 'POST' && url === '/shutdown') {
      if (stopping) return json(200, { ok: true, already: true })
      stopping = true
      json(200, { ok: true, stopping: true })
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50)
      return
    }
    json(404, { ok: false, error: 'not found' })
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`E2E_DAEMON_READY port=${port} pid=${process.pid}`)
  })

  ctx.effect(() => () => {
    for (const fn of off.splice(0)) { try { fn() } catch { /* ignore */ } }
    server.close()
    console.log('E2E_DAEMON_STOPPED')
  }, 'feishu-e2e-daemon')
}
