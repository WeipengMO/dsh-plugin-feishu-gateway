import { describe, expect, it } from 'vitest'
import { commandHelp, parseControlCommand } from '../../src/control/commands.js'

describe('Feishu slash commands', () => {
  it.each(['/help', '/status', '/cancel', '/new', '/compact', '/context'] as const)('recognizes %s', (command) => {
    expect(parseControlCommand(command)).toBe(command.slice(1))
  })
  it('ignores surrounding whitespace and case', () => {
    expect(parseControlCommand('  /STATUS  ')).toBe('status')
    expect(parseControlCommand('/NeW\n')).toBe('new')
  })
  it('does not hijack normal prompts or commands with arguments', () => {
    expect(parseControlCommand('hello /new')).toBeUndefined()
    expect(parseControlCommand('/new important topic')).toBeUndefined()
    expect(parseControlCommand('/compact now')).toBeUndefined()
    expect(parseControlCommand('please /compact')).toBeUndefined()
    expect(parseControlCommand('/cancelled')).toBeUndefined()
    expect(parseControlCommand('/path/to/file')).toBeUndefined()
  })
  it('supports model selection and stop while keeping cancel as a compatibility alias', () => {
    expect(parseControlCommand('/stop')).toBe('cancel')
    expect(parseControlCommand('/model')).toBe('model')
    expect(parseControlCommand('/models')).toBe('models')
    expect(parseControlCommand('/models magpie/group/hy4-free')).toBe('models')
    expect(parseControlCommand('/model magpie/group/hy4-free')).toBe('model')
  })
  it('explains cancellation safety and Session semantics', () => {
    expect(commandHelp).toContain('/stop')
    expect(commandHelp).toContain('/models — 查看可用模型及当前会话模型')
    expect(commandHelp).toContain('/model provider/model — 切换当前会话模型')
    expect(commandHelp).toContain('/new')
    expect(commandHelp).toContain('/context')
    expect(commandHelp).toContain('/compact')
    expect(commandHelp).toContain('回滚')
  })
})
