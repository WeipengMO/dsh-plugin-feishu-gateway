import { describe, expect, it } from 'vitest'
import { commandHelp, parseControlCommand } from '../../src/control/commands.js'

describe('Feishu slash commands', () => {
  it.each(['/help', '/status', '/cancel', '/new'] as const)('recognizes %s', (command) => {
    expect(parseControlCommand(command)).toBe(command.slice(1))
  })
  it('ignores surrounding whitespace and case', () => {
    expect(parseControlCommand('  /STATUS  ')).toBe('status')
    expect(parseControlCommand('/NeW\n')).toBe('new')
  })
  it('does not hijack normal prompts or commands with arguments', () => {
    expect(parseControlCommand('hello /new')).toBeUndefined()
    expect(parseControlCommand('/new important topic')).toBeUndefined()
    expect(parseControlCommand('/cancelled')).toBeUndefined()
    expect(parseControlCommand('/path/to/file')).toBeUndefined()
  })
  it('explains cancellation safety and Session semantics', () => {
    expect(commandHelp).toContain('/cancel')
    expect(commandHelp).toContain('/new')
    expect(commandHelp).toContain('回滚')
  })
})
