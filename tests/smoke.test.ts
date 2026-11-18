import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('module resolution smoke test', () => {
  it('resolves .js specifiers to TypeScript sources under Vitest', () => {
    const config = resolveConfig({ bots: [{ id: 'default', enabled: true, domain: 'feishu' }] })
    expect(config.bots[0]?.id).toBe('default')
  })
})
