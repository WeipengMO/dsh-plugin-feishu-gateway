import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
const dir = path.resolve(import.meta.dirname, '..')
const output = path.join(dir, 'lib')
mkdirSync(output, { recursive: true })
copyFileSync(path.join(dir, 'src/server.mjs'), path.join(output, 'index.mjs'))
const css = readFileSync(path.join(dir, 'src/client.css'), 'utf8')
const js = readFileSync(path.join(dir, 'src/client.js'), 'utf8')
if (!js.includes('__CSS_TEXT__')) throw Error('missing CSS marker')
writeFileSync(path.join(output, 'client.js'), js.replace('__CSS_TEXT__', () => JSON.stringify(css)))
console.log('Feishu web-admin built')
