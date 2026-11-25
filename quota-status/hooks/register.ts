import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, SessionContextUsage, SessionRateLimit, SessionCost, ModelUsage } from 'claude-code'

import type { Spend } from '../types'

type Reading = { context: SessionContextUsage; rateLimits: SessionRateLimit[]; cost?: SessionCost; spend?: Spend }

/** `plan`: a subscription, shown as quota and time to reset. `api`: billed per token, shown as dollars. */
export type Billing = 'plan' | 'api'

const SEP = '  │  '

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

function windowPart(label: string, w: SessionRateLimit | undefined, now: number): string {
  if (!w) return `${label} —`
  const used = Math.round(w.percentUsed)
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isNaN(reset) ? `${label} ${used}%` : `${label} ${used}% · ${formatDuration(reset - now)}`
}

export function formatUsd(usd: number): string {
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

// List prices in $ per million tokens: input, output, cache read, cache write.
// The engine only reports the session's total, so the transcripts' tokens
// are priced here to find subagents' share.
type Rates = { in: number; out: number; read: number; write: number }
const rates = (input: number, read = input / 10): Rates => ({ in: input, out: input * 5, read, write: input * 1.25 })
const PRICES: [RegExp, Rates][] = [
  [/fable|mythos/, rates(10, 0.25)],
  [/opus-5-5/, rates(4, 0.2)],
  [/opus/, rates(5)],
  [/sonnet-5/, rates(2, 0.2)],
  [/sonnet/, rates(3)],
  [/haiku-5/, rates(0.1)],
  [/haiku/, rates(1)],
]
const FALLBACK = rates(4, 0.2)

/** What a response would cost at list price, in dollars. */
export function listPrice(model: string, u: ModelUsage): number {
  const r = PRICES.find(([re]) => re.test(model))?.[1] ?? FALLBACK
  return (
    (u.input_tokens * r.in + u.output_tokens * r.out + u.cache_read_input_tokens * r.read + u.cache_creation_input_tokens * r.write) /
    1_000_000
  )
}

/**
 * Subagents at their transcripts' list price; main as the rest of the
 * engine's total, or its own transcript's price where that is more (a
 * resumed session whose engine total starts over). Main keeps what no
 * transcript records: compaction, classifiers, other plugins' model calls.
 */
export function splitCost(total: number, spend: Spend | undefined): { main: number; agents: number } {
  const agents = Math.max(0, spend?.agents ?? 0)
  return { main: Math.max(total - agents, spend?.main ?? 0, 0), agents }
}

export function formatCost(total: number, spend: Spend | undefined): string {
  const { main, agents } = splitCost(total, spend)
  const sum = main + agents
  // A short subagent run is a fraction of a cent, which would round to $0.00.
  const part = (usd: number) => (usd > 0 && usd < 0.005 ? '<$0.01' : formatUsd(usd))
  return agents > 0 ? `${formatUsd(sum)} (main ${part(main)} · agents ${part(agents)})` : formatUsd(sum)
}

// Rate-limit windows are only reported on a subscription, so their presence
// settles it; before the first response the credential's kind decides.
export function billingOf(r: Reading, fallback: Billing): Billing {
  return r.rateLimits.length > 0 ? 'plan' : fallback
}

export function formatLine(r: Reading, now: number, fallback: Billing = 'api'): string {
  const parts: string[] = []
  if (billingOf(r, fallback) === 'plan') {
    parts.push(windowPart('5h', r.rateLimits.find(w => w.kind === 'five_hour'), now))
    parts.push(windowPart('wk', r.rateLimits.find(w => w.kind === 'seven_day'), now))
  } else if (r.cost) {
    parts.push(formatCost(r.cost.usd, r.spend))
  }
  const { tokens, window, percent } = r.context
  parts.push(
    tokens === undefined || percent === undefined
      ? `ctx — · ${formatTokens(window)}`
      : `ctx ${percent}% · ${formatTokens(tokens)}/${formatTokens(window)}`,
  )
  return parts.join(SEP)
}

// Sums every request in the session's transcripts once (an answer is written
// as a row per content block, each with the same usage), per scope and model:
// `main|agents <tab> model <tab> input <tab> output <tab> cache read <tab> cache write`.
export const SUM_AWK = `# Sums each request's usage once (by requestId) per scope and model.
function num(s, key,   i, rest) {
  i = index(s, "\\"" key "\\":")
  if (!i) return 0
  rest = substr(s, i + length(key) + 3)
  match(rest, /^[0-9]+/)
  return RLENGTH > 0 ? substr(rest, 1, RLENGTH) + 0 : 0
}
function str(s, key,   i, rest) {
  i = index(s, "\\"" key "\\":\\"")
  if (!i) return ""
  rest = substr(s, i + length(key) + 4)
  return substr(rest, 1, index(rest, "\\"") - 1)
}
index($0, "\\"usage\\":{") {
  id = str($0, "requestId"); if (id == "") id = str($0, "id")
  if (id == "" || (id in seen)) next
  seen[id] = 1
  scope = FILENAME ~ /\\/subagents\\// ? "agents" : "main"
  m = substr($0, index($0, "\\"message\\":")); model = str(m, "model")
  u = substr($0, index($0, "\\"usage\\":{"))
  k = scope "\\t" model
  tin[k] += num(u, "input_tokens"); tout[k] += num(u, "output_tokens")
  trd[k] += num(u, "cache_read_input_tokens"); twr[k] += num(u, "cache_creation_input_tokens")
}
END { for (k in tin) printf "%s\\t%d\\t%d\\t%d\\t%d\\n", k, tin[k], tout[k], trd[k], twr[k] }
`

// Finds the session's transcript and its subagents' wherever the project's
// folder is named, and hands awk only files that exist (it stops at a missing one).
const FIND_AND_SUM = `cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; sid=$1; prog=$2; set --
for f in "$cfg"/projects/*/"$sid".jsonl "$cfg"/projects/*/"$sid"/subagents/*.jsonl; do [ -f "$f" ] && set -- "$@" "$f"; done
[ $# -gt 0 ] || exit 0
exec awk "$prog" "$@"`

/** Prices the summariser's lines: list-price dollars for main and for subagents. */
export function priceTranscripts(stdout: string): Spend {
  const spent: Spend = { main: 0, agents: 0 }
  for (const row of stdout.split('\n')) {
    const [scope, model = '', ...n] = row.split('\t')
    if (scope !== 'main' && scope !== 'agents') continue
    const [input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens] = n.map(Number)
    spent[scope] += listPrice(model, { input_tokens: input_tokens!, output_tokens: output_tokens!, cache_read_input_tokens: cache_read_input_tokens!, cache_creation_input_tokens: cache_creation_input_tokens! })
  }
  return spent
}

const line = atom({ plugin: 'quota-status', key: 'line' } as const, null)
// The transcripts' list-price totals, kept so a reload draws them at once.
const spend = atom({ plugin: 'quota-status', key: 'spend' } as const, { main: 0, agents: 0 })

let last: Reading | undefined
let billing: Billing = 'api'

// A long transcript takes awk a second or two, so a reading runs in the
// background, one at a time, and at most every REFRESH_MS; a request that
// lands meanwhile is picked up by the next one.
const REFRESH_MS = 30_000
let lastRun = -Infinity
let running = false
let stale = true

async function refresh($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now()
  if (running || !stale || (!force && now - lastRun < REFRESH_MS)) return
  running = true
  stale = false
  lastRun = now
  try {
    const r = await $.process.run(['sh', '-c', FIND_AND_SUM, 'sh', await $.session.id(), SUM_AWK])
    if (r.exitCode === 0 && !r.isStdoutTruncated) {
      const spent = priceTranscripts(r.stdout)
      await update($, spend, () => spent)
      await draw($)
    }
  } catch {
    // No transcript to read (an SDK host, a sandbox): the engine's total stands alone.
  } finally {
    running = false
  }
}

async function draw($: EngineInterface): Promise<void> {
  if (!last) return
  const text = formatLine({ ...last, spend: await read($, spend) }, await $.clock.now(), billing)
  await update($, line, () => text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Clears the pin an earlier version of this mod left in the notice slot.
    $.ui.status(undefined)
    // An OAuth bearer is a claude.ai login (a plan); an API key, or no
    // first-party credential (Bedrock, Vertex, a gateway), is billed per token.
    billing = (await $.session.authorize())?.kind === 'bearer' ? 'plan' : 'api'
    last = await $.session.usage()
    await draw($)
    void refresh($, true)
    // Keeps the reset countdowns current, and catches up a reading a burst of requests skipped.
    $.clock.every(60_000, async () => {
      await draw($)
      await refresh($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    last = { context: e.context, rateLimits: e.rateLimits, cost: e.cost }
    await draw($)
    if (e.changed.includes('cost')) {
      stale = true
      void refresh($)
    }
    return next(e)
  })

  // Drawn dim at the end of the hint line under the prompt; $.ui.status would
  // put it in the engine's warning-styled notice slot instead. Goes in front of
  // what other mods added, which add theirs after, so the order of plugins
  // doesn't change the line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const text = await read($, line)
    if (!text) return next(e)
    const tail = e.props.tail ? `${text}${SEP}${e.props.tail}` : text
    return next({ ...e, props: { ...e.props, tail } })
  })
}
