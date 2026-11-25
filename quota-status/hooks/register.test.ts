import { test, expect } from 'claude-code/testing'
import { formatLine, formatDuration, formatUsd, listPrice, splitCost, priceTranscripts } from './register'

const now = Date.parse('2026-10-31T12:00:00Z')

test('formats all three parts', () => {
  const line = formatLine({
    context: { tokens: 76_000, window: 200_000, percent: 38 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 38, resetsAt: '2026-10-31T14:14:00Z' },
      { kind: 'seven_day', percentUsed: 19, resetsAt: '2026-11-03T16:00:00Z' },
    ],
  }, now)
  expect(line).toBe('5h 38% · 2h14m  │  wk 19% · 3d4h  │  ctx 38% · 76k/200k')
})

test('plan shows quota and reset, not dollars', () => {
  const line = formatLine({
    context: { tokens: 76_000, window: 200_000, percent: 38 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 38, resetsAt: '2026-10-31T14:14:00Z' }],
    cost: { usd: 4.2 },
  }, now)
  expect(line).toBe('5h 38% · 2h14m  │  wk —  │  ctx 38% · 76k/200k')
})

test('API pricing shows dollars used', () => {
  const line = formatLine({
    context: { tokens: 76_000, window: 200_000, percent: 38 },
    rateLimits: [],
    cost: { usd: 1.234 },
  }, now, 'api')
  expect(line).toBe('$1.23  │  ctx 38% · 76k/200k')
})

test('API pricing shows subagents at list price and main as the rest of the total', () => {
  const line = formatLine({
    context: { tokens: 76_000, window: 200_000, percent: 38 },
    rateLimits: [],
    cost: { usd: 4 },
    spend: { main: 0.5, agents: 1 },
  }, now, 'api')
  expect(line).toBe('$4.00 (main $3.00 · agents $1.00)  │  ctx 38% · 76k/200k')
})

test('splitting the total', () => {
  expect(splitCost(2, { main: 1, agents: 0 })).toEqual({ main: 2, agents: 0 })
  expect(splitCost(2, undefined)).toEqual({ main: 2, agents: 0 })
  // What no transcript records stays with main.
  expect(splitCost(5, { main: 0.1, agents: 0.003 })).toEqual({ main: 4.997, agents: 0.003 })
  // A resumed session whose engine total started over: the transcripts win.
  expect(splitCost(1, { main: 6, agents: 2 })).toEqual({ main: 6, agents: 2 })
})

test('a resumed session shows the transcripts when they cost more than the engine total', () => {
  const line = formatLine({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 1 }, spend: { main: 6, agents: 2 } }, now, 'api')
  expect(line).toBe('$8.00 (main $6.00 · agents $2.00)  │  ctx — · 200k')
})

test('a subagent costing a fraction of a cent reads as under a cent, not $0.00', () => {
  const line = formatLine({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 4.78 }, spend: { main: 4.7, agents: 0.0044 } }, now, 'api')
  expect(line).toBe('$4.78 (main $4.78 · agents <$0.01)  │  ctx — · 200k')
})

test('pricing the summariser output', () => {
  const spent = priceTranscripts(
    'main\tclaude-opus-5-5\t1000000\t0\t0\t0\nagents\tclaude-haiku-5-5\t0\t1000000\t0\t0\nagents\tclaude-sonnet-5-5\t1000000\t0\t0\t0\n',
  )
  expect(spent).toEqual({ main: 4, agents: 0.5 + 2 })
})

test('list price weighs models and token kinds', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }
  expect(listPrice('claude-opus-5-5', u).toFixed(4)).toBe('24.2000')
  expect(listPrice('claude-haiku-5-5', u).toFixed(4)).toBe('0.6100')
})

test('the status line splits the engine total by what the transcripts record', async ($, on) => {
  const runs: string[][] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: { kind: 'apiKey' } as any }))
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('ui.status', () => ({ value: undefined as any }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'main\tclaude-opus-5-5\t1000000\t0\t0\t0\nagents\tclaude-opus-5-5\t1000000\t0\t0\t0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // Stands in for the engine's hint line: draws the tail the mod hands it.
  on('ui.render', ($, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, String(e.props.tail ?? '')) as any
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 30 }, changed: ['cost'] } as any)

  // The session's own id reaches the summariser.
  expect(runs[0]?.[4]).toBe('sid-1')
  const ui = await $.ui.mount({ plugin: 'quota-status', component: 'PromptHint', surface: 'terminal', props: {} } as any)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('$30.00 (main $26.00 · agents $4.00)  │  ctx — · 200k')
  await ui.unmount()

  // A tail another mod set first stays, after this one's.
  const tagged = await $.ui.mount({ plugin: 'quota-status', component: 'PromptHint', surface: 'terminal', props: { tail: '🏠 claude-personal' } } as any)
  expect((await tagged.find({ type: 'Text' }))?.text).toBe('$30.00 (main $26.00 · agents $4.00)  │  ctx — · 200k  │  🏠 claude-personal')
  await tagged.unmount()
})

test('plan login before first response shows empty windows', () => {
  expect(formatLine({ context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } }, now, 'plan'))
    .toBe('5h —  │  wk —  │  ctx — · 1M')
})

test('context only with no cost ledger, before first response', () => {
  expect(formatLine({ context: { window: 1_000_000 }, rateLimits: [] }, now)).toBe('ctx — · 1M')
})

test('dollars', () => {
  expect(formatUsd(0)).toBe('$0.00')
  expect(formatUsd(12.345)).toBe('$12.35')
  expect(formatUsd(250.6)).toBe('$251')
})

test('durations', () => {
  expect(formatDuration(41 * 60_000)).toBe('41m')
  expect(formatDuration(-5)).toBe('0m')
})
