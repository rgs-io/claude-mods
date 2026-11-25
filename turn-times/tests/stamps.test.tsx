import { expect, test } from 'claude-code/testing'

import { formatAgo, formatClock, formatStamp, parseOffset, parseStamps } from '../hooks/register'

const MIN = 60_000
const AT = Date.parse('2026-11-06T01:02:00Z') // 14:02 in NZDT (+1300)

test('relative times read as minutes, hours, then days', async () => {
  expect(formatAgo(10_000)).toBe('just now')
  expect(formatAgo(4 * MIN)).toBe('4 min ago')
  expect(formatAgo(59 * MIN)).toBe('59 min ago')
  expect(formatAgo(125 * MIN)).toBe('2 hr ago')
  expect(formatAgo(25 * 60 * MIN)).toBe('1 day ago')
  expect(formatAgo(3 * 24 * 60 * MIN)).toBe('3 days ago')
  expect(formatAgo(-5_000)).toBe('just now')
})

test('the clock time is local, and dropped when narrow', async () => {
  expect(parseOffset('+1300\n')).toBe(780)
  expect(parseOffset('-0330')).toBe(-210)
  expect(parseOffset('garbage')).toBeUndefined()
  expect(formatClock(AT, 780)).toBe('14:02')
  expect(formatClock(AT, 0)).toBe('01:02')
  expect(formatStamp(AT, AT + 12 * MIN, 780, 120)).toBe('14:02 · 12 min ago')
  expect(formatStamp(AT, AT + 12 * MIN, 780, 60)).toBe('12 min ago')
})

test('transcript stamps parse, skipping a cut-off last line', async () => {
  const out = 'a\t2026-11-06T01:02:00.000Z\nb\t2026-11-06T01:05:00.000Z\nc\t2026-11'
  expect(parseStamps(out)).toEqual({ a: AT, b: AT + 3 * MIN })
})

const PROMPT = {
  plugin: 'turn-times',
  component: 'UserMessage',
  requestId: 'u1',
  viewport: { columns: 120, rows: 40 },
  props: { text: 'deploy it', origin: { kind: 'prompt' }, isExpanded: false },
} as const

test('a prompt with a known time draws its stamp beside the row', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  on('state.get', (_, e) => {
    if (e.key === 'at' && e.id === 'u1') return { value: { value: AT, version: 1 } }
    if (e.key === 'now') return { value: { value: AT + 12 * MIN, version: 1 } }
    if (e.key === 'offset') return { value: { value: 780, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PROMPT, surface } as never)
    expect((await ui.find({ type: 'Text', text: /engine row/ }))?.text).toBe('engine row')
    expect((await ui.find({ type: 'Text', text: /ago/ }))?.text).toBe('14:02 · 12 min ago')
    await ui.unmount()
  }
})

test('a row with no known time is drawn as the engine draws it', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /ago/ })).toBeUndefined()
  await ui.unmount()
})

test('a row whose append was skipped gets its time from the transcript when drawn', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: AT + 12 * MIN }))
  on('clock.every', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  // The row reaches the file after the session's first read, its append hook skipped.
  let reads = 0
  on('process.run', (_, e) => {
    const isDate = e.argv[0] === 'date'
    if (!isDate) reads++
    const stdout = isDate ? '+1300\n' : reads > 1 ? 'u1\t2026-11-06T01:02:00.000Z\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', signal: null, isTimedOut: false } as never }
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text', text: /ago/ }))?.text).toBe('14:02 · 12 min ago')
  await ui.unmount()
})

test('a /resume in the process reads the resumed session\'s transcript', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: AT + 12 * MIN }))
  on('clock.every', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}) as any)
  on('session.id', () => ({ value: 's1' }))
  const ids: string[] = []
  on('process.run', (_, e) => {
    const isDate = e.argv[0] === 'date'
    if (!isDate) ids.push(String(e.argv[4]))
    const stdout = isDate ? '+1300\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', signal: null, isTimedOut: false } as never }
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  // The hook's session_id names the new session before $.session.id() does.
  await $.classic.SessionStart({ source: 'resume', session_id: 's2' } as any)
  // Both reads run unawaited; let them settle.
  await new Promise(r => (globalThis as any).setTimeout(r, 20))

  expect(ids).toEqual(['s1', 's2'])
})
