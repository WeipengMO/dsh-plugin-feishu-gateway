import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
const dir = path.resolve(import.meta.dirname, '..')
const output = path.join(dir, 'lib')
mkdirSync(output, { recursive: true })
copyFileSync(path.join(dir, 'src/server.mjs'), path.join(output, 'index.mjs'))
copyFileSync(path.join(dir, 'src/ops-read.mjs'), path.join(output, 'ops-read.mjs'))
copyFileSync(path.join(dir, 'src/agent-profile.mjs'), path.join(output, 'agent-profile.mjs'))
const css = readFileSync(path.join(dir, 'src/client.css'), 'utf8')
const js = readFileSync(path.join(dir, 'src/client.js'), 'utf8')
const workbench = readFileSync(path.join(dir, 'src/workbench.js'), 'utf8')
const opsPages = readFileSync(path.join(dir, 'src/ops-pages.js'), 'utf8')
const agentProfileUI = readFileSync(path.join(dir, 'src/agent-profile-ui.js'), 'utf8')
if (!js.includes('__CSS_TEXT__') || !js.includes('/*__WORKBENCH_CODE__*/'))
  throw Error('missing client asset marker')
writeFileSync(path.join(output, 'client.js'), js
  .replace('__CSS_TEXT__', () => JSON.stringify(css))
  .replace('/*__WORKBENCH_CODE__*/', () => opsPages + '\n' + agentProfileUI + '\n' + workbench))
console.log('Feishu web-admin built')
