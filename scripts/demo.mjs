#!/usr/bin/env node
/**
 * 本地全链路演示：不启动 DSH、不装进任何 profile、不连接飞书。
 *
 *   node scripts/demo.mjs "你好"                 # 白名单内用户，应收到回复
 *   node scripts/demo.mjs "你好" ou_stranger     # 白名单外用户，应被丢弃
 *
 * 前提：先 `pnpm run build`（脚本 import 的是构建产物 lib/）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../lib/index.js'
import { MockFeishuTransport } from '../lib/channel/mock-transport.js'
import { MockSessionBridge } from '../lib/session/mock-session-bridge.js'
import { resolveConfig } from '../lib/config.js'
import { silentLogger } from '../lib/util/logger.js'

// pnpm 12 forwards a literal `--` when invoked as `pnpm run demo -- "text"`.
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const text = args[0] ?? '你好，飞书网关'
const sender = args[1] ?? 'ou_demo_user'

const stateDir = await mkdtemp(path.join(os.tmpdir(), 'feishu-gw-demo-'))
const config = resolveConfig({
  stateDir,
  allowlist: ['ou_demo_user'],
  offline: true,
  sendRetries: 1,
})
const transport = new MockFeishuTransport('default')
const bridge = new MockSessionBridge({ reply: (prompt) => `DSH 原生 Session 回复：${prompt}` })
const gateway = createGateway(config, { transports: [transport], bridge, logger: silentLogger })

try {
  await gateway.start()
  console.log('── 入站 ──')
  console.log(`  senderId : ${sender}`)
  console.log(`  text     : ${text}`)

  await transport.emitMessage({ senderId: sender, text })
  await gateway.whenIdle()

  const health = gateway.health()
  console.log('── 出站 ──')
  if (transport.sent.length === 0) {
    console.log('  (无回复)')
  } else {
    for (const sent of transport.sent) console.log(`  ${sent.text}`)
  }
  console.log('── 状态 ──')
  console.log(`  status    : ${health.status}`)
  console.log(`  processed : ${health.processed}`)
  console.log(`  rejected  : ${JSON.stringify(health.rejected)}`)
  console.log(`  created   : ${bridge.created.length} 个原生 Session / prompts: ${bridge.prompts.length}`)
} finally {
  await gateway.stop()
  await rm(stateDir, { recursive: true, force: true })
}
