import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { validateEntries } from './check-package-contents.mjs'

test('only intended package paths are published', () => {
  assert.deepEqual(validateEntries('dsh-plugin-feishu-gateway', [
    'package/package.json', 'package/README.md', 'package/docs/GETTING-STARTED.md',
    'package/profiles/feishu-channel.env.example', 'package/lib/index.js',
  ]), [])
  assert.deepEqual(validateEntries('dsh-plugin-feishu-admin', [
    'package/package.json', 'package/lib/client.js', 'package/cordis.patch.yml',
  ]), [])
})
test('rejects runtime histories, credential files, and path traversal', () => {
  for (const entry of [
    'package/.env', 'package/docs/.env.local', 'package/profiles/id_ed25519',
    'package/docs/private-key.pem', 'package/docs/session.v4.jsonl.zstd',
    'package/lib/admin-config.json', 'package/docs/conversation.sqlite',
    'package/docs/debug.log', 'package/docs/.ssh/config',
    'package/lib/../../etc/passwd', 'package/.git/config',
    'package/node_modules/evil.js', 'package/docs/secret-backup.txt',
  ]) {
    assert.ok(validateEntries('dsh-plugin-feishu-gateway', [entry]).length, entry)
  }
})
test('rejects unknown npm packages and extra source folders', () => {
  assert.ok(validateEntries('other-plugin', ['package/lib/index.js']).length)
  assert.ok(validateEntries('dsh-plugin-feishu-admin', ['package/src/password.ts']).length)
})
