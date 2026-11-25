import { test, expect } from 'claude-code/testing'

// Stands in for the engine: env, the command registration, and a hint line
// that draws the tail it's handed.
function engine(on: any, env: Record<string, string>) {
  on('env.get', (_: any, e: any) => ({ value: env[e.name] }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, String(e.props.tail ?? '')) as any
  })
}

async function hint($: any, tail?: string) {
  const ui = await $.ui.mount({ plugin: 'import-session', component: 'PromptHint', surface: 'terminal', props: tail ? { tail } : {} })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

const ENV = { HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/Users/me/.claude-personal' }

test('the profile alone ends the hint line, with its emoji', { options: { profileEmoji: 'claude-personal=🏠' } }, async ($, on) => {
  engine(on, ENV)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as any)
  expect(await hint($)).toBe('🏠 claude-personal')
})

test('the profile goes after what another mod put on the line', async ($, on) => {
  engine(on, ENV)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as any)
  expect(await hint($, 'ctx 7% · 71k/1M')).toBe('ctx 7% · 71k/1M  │  claude-personal')
})

test('no CLAUDE_CONFIG_DIR is the default profile, claude', async ($, on) => {
  engine(on, { HOME: '/Users/me' })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as any)
  expect(await hint($)).toBe('claude')
})

test('showProfile off leaves the line alone', { options: { showProfile: false } }, async ($, on) => {
  engine(on, ENV)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as any)
  expect(await hint($, 'ctx 7%')).toBe('ctx 7%')
})
