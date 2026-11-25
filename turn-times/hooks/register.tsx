import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, RenderInput, RenderElement } from 'claude-code'

const now = atom({ plugin: 'turn-times', key: 'now' } as const, 0)
const offset = atom({ plugin: 'turn-times', key: 'offset' } as const, 0)
const loaded = atom({ plugin: 'turn-times', key: 'loaded' } as const, {})

const MINUTE = 60_000
// Below this many columns the clock time is dropped and only "x ago" is shown.
const NARROW = 80

/** `just now`, `4 min ago`, `2 hr ago`, `3 days ago`. */
export function formatAgo(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / MINUTE)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** `14:02`, in the zone `offsetMin` minutes east of UTC. */
export function formatClock(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * MINUTE)
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function formatStamp(at: number, nowMs: number, offsetMin: number, columns?: number): string {
  const ago = formatAgo(nowMs - at)
  return columns !== undefined && columns < NARROW ? ago : `${formatClock(at, offsetMin)} · ${ago}`
}

/** `+1300` → 780, `-0330` → -210. */
export function parseOffset(s: string): number | undefined {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(s.trim())
  if (!m) return undefined
  const mins = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -mins : mins
}

// Prints `uuid <tab> timestamp` for each prompt, reply and turn-end row of the
// session's main transcript; the drawing finds rows by these ids.
const STAMPS = `cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; sid=$1; set --
for f in "$cfg"/projects/*/"$sid".jsonl; do [ -f "$f" ] && set -- "$@" "$f"; done
[ $# -gt 0 ] || exit 0
exec awk '
function str(key,   i, rest) {
  i = index($0, "\\"" key "\\":\\"")
  if (!i) return ""
  rest = substr($0, i + length(key) + 4)
  return substr(rest, 1, index(rest, "\\"") - 1)
}
/"type":"(user|assistant)"/ || /"subtype":"turn_duration"/ {
  u = str("uuid"); t = str("timestamp")
  if (u != "" && t != "") print u "\\t" t
}' "$@"`

/** Reads the awk's lines into a table; a truncated last line is dropped. */
export function parseStamps(stdout: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of stdout.split('\n')) {
    const [uuid, iso] = row.split('\t')
    if (!uuid || !iso || !/T\d\d:\d\d:\d\d/.test(iso)) continue
    const at = Date.parse(iso)
    if (!Number.isNaN(at)) out[uuid] = at
  }
  return out
}

async function backfill($: EngineInterface): Promise<void> {
  try {
    const tz = await $.process.run(['date', '+%z'])
    const off = parseOffset(tz.stdout)
    if (off !== undefined) await update($, offset, () => off)
    const r = await $.process.run(['sh', '-c', STAMPS, 'sh', await $.session.id()])
    if (r.exitCode === 0) {
      const stamps = parseStamps(r.stdout)
      await update($, loaded, () => stamps)
    }
  } catch {
    // No shell or no transcript (an SDK host, a sandbox): only rows appended from now on get times.
  }
}

// Reading the transcript again when a drawn row has no time, at most this often.
const REFILL_MS = 5_000
let lastRefill = 0
let refilling = false

/**
 * Reads the transcript again for a row that has no time. That happens when a
 * plugin above skips this one's session.append hook, as an organization's
 * policy plugin does for the person's plugins. The row is already in the file
 * by the time it is drawn, so its time is there.
 */
async function refill($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  if (refilling || t - lastRefill < REFILL_MS) return
  refilling = true
  lastRefill = t
  try {
    await backfill($)
  } finally {
    refilling = false
  }
}

async function stampOf($: EngineInterface, id: string): Promise<number | undefined> {
  const { value } = await $.state.get({ plugin: 'turn-times', key: 'at', id })
  const at = value ?? (await read($, loaded))[id]
  if (at === undefined) void refill($).catch(() => {})
  return at
}

/** The stamp a row draws, or undefined while its time is unknown. */
async function stampText($: EngineInterface, e: RenderInput, isAgoOnly = false): Promise<string | undefined> {
  const at = await stampOf($, e.requestId)
  if (at === undefined) return undefined
  const nowMs = Math.max(await read($, now), at)
  return formatStamp(at, nowMs, await read($, offset), isAgoOnly ? 0 : e.viewport?.columns)
}

/**
 * The engine's row, with the stamp at its top right. The row is opaque to a
 * hook, and each of the rows stamped here opens with a blank line, so the
 * stamp is laid out of the flow on that line: the row keeps its full width and
 * its text wraps as it would without the mod.
 */
function beside($: EngineInterface, e: RenderInput, row: RenderElement, text: string): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {row}
      <Box position="absolute" top={0} right={0}>
        <Text dimColor>{text}</Text>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const tick = async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
    }
    await tick()
    $.clock.every(MINUTE, () => void tick())
    void backfill($)
    return result
  })

  // A /resume or /clear goes on in this process under another session, with
  // its own $.state and transcript; session.start doesn't fire for it.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'startup') {
      const t = await $.clock.now()
      await update($, now, () => t)
      void backfill($)
    }
    return result
  })

  // A turn's closing line is written straight to the transcript, past
  // session.append, so its time is read from the file once it lands there.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) $.clock.after(2_000, () => void backfill($))
    return result
  })

  // Main conversation rows only: a subagent's rows are not drawn in the main transcript.
  // A plugin above may continue past this hook; the row then gets its time
  // from the transcript when it is drawn (stampOf).
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    const { type, name } = e.message
    const isStamped = type === 'user' || type === 'assistant' || (type === 'system' && name === 'turn_duration')
    if (e.agentId === undefined && isStamped && result.uuid) {
      try {
        await $.state.set({ plugin: 'turn-times', key: 'at', id: result.uuid }, await $.clock.now())
      } catch {
        // The row is stored either way; it just draws without a time.
      }
    }
    return result
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const text = await stampText($, e)
    return text === undefined ? next(e) : beside($, e, await next(e), text)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.isFirstOfReply ? await stampText($, e) : undefined
    return text === undefined ? next(e) : beside($, e, await next(e), text)
  })

  // The line already says when the turn finished (`done 3:16 PM`): add how long ago.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const text = await stampText($, e, true)
    return text === undefined ? next(e) : beside($, e, await next(e), text)
  })
}
