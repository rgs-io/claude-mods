import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Feature, Ticket } from '../types'

const PANE = 'scratch-board'
const TITLE = 'Tickets'
const POLL_MS = 2000

const features = atom({ plugin: 'scratch-board', key: 'features' } as const, [])
const expanded = atom({ plugin: 'scratch-board', key: 'expanded' } as const, null)
const hideDone = atom({ plugin: 'scratch-board', key: 'hideDone' } as const, true)
// 'upcoming': one queue across every spec. 'spec': each spec with its own tickets under it.
const view = atom({ plugin: 'scratch-board', key: 'view' } as const, 'upcoming')

// Sort order (top to bottom) and colour per status. Anything unknown sorts
// after needs-info and is drawn in the plain text colour.
type Style = { rank: number; color: string; glyph: string }

const STATUS: Record<string, Style> = {
  'ready-for-agent': { rank: 0, color: 'success', glyph: '●' },
  claimed: { rank: 1, color: 'claude', glyph: '◐' },
  'in-progress': { rank: 1, color: 'claude', glyph: '◐' },
  'ready-for-human': { rank: 2, color: 'permission', glyph: '●' },
  'needs-triage': { rank: 3, color: 'warning', glyph: '?' },
  'needs-info': { rank: 4, color: 'error', glyph: '!' },
  wontfix: { rank: 8, color: 'inactive', glyph: '×' },
  done: { rank: 9, color: 'subtle', glyph: '✓' },
  resolved: { rank: 9, color: 'subtle', glyph: '✓' },
}
const UNKNOWN: Style = { rank: 5, color: 'text', glyph: '·' }
const styleOf = (status: string) => STATUS[status] ?? UNKNOWN
const BLOCKED_RANK = 6

const isFinished = (status: string) => (STATUS[status]?.rank ?? 0) >= 8

const firstWord = (text: string) => text.toLowerCase().split(/\s/)[0] ?? ''

// `**Status:** done`, `Status: ready-for-agent`, `- **Type:** task` all match.
const field = (text: string, name: string) => {
  const re = new RegExp(`^[-*\\s]*\\**${name}:?\\**:?\\**\\s*(.+)$`, 'im')
  const head = text.split('\n').slice(0, 30).join('\n')
  return head.match(re)?.[1]?.replace(/[`*]/g, '').trim()
}

const heading = (text: string) =>
  text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ''

const parseTicket = (feature: string, file: string, name: string, text: string): Ticket => {
  const num = name.match(/^(\d+)/)?.[1] ?? ''
  const title = heading(text).replace(/^\d+\s*[:.-]\s*/, '') || name
  const status = firstWord(field(text, 'Status') ?? 'needs-triage')
  const blockedRaw = field(text, 'Blocked by') ?? ''
  const blockedBy = /^none/i.test(blockedRaw)
    ? []
    : [...blockedRaw.replace(/\([^)]*\)/g, '').matchAll(/\b(\d+)\b/g)].map(m => m[1]!.padStart(num.length || 2, '0'))
  const summary = (text.match(/\*\*What to build:\*\*\s*([\s\S]*?)(\n\s*\n|$)/)?.[1] ?? '').trim()

  return { id: `${feature}/${num || name}`, file, num, title, status, type: field(text, 'Type')?.toLowerCase(), blockedBy, summary }
}

const isBlocked = (ticket: Ticket, byNum: Map<string, Ticket>) =>
  !isFinished(ticket.status) && ticket.blockedBy.some(n => !isFinished(byNum.get(n)?.status ?? 'done'))

const rankOf = (ticket: Ticket, byNum: Map<string, Ticket>) => {
  const base = styleOf(ticket.status).rank
  return isBlocked(ticket, byNum) && base < BLOCKED_RANK ? BLOCKED_RANK + base / 10 : base
}

// Parsed files keyed by path, re-read only when their mtime moves. A reload
// starts this over, which costs one full read.
const cache = new Map<string, { mtimeMs: number; text: string }>()
// Unset after a reload, so the first scan writes what it finds over what $.state kept.
let lastSignature: string | undefined
// The pane opens itself once, the first time .scratch has anything to show,
// so projects without tickets never get it. Closing it keeps it closed.
// When .scratch empties the pane closes, and opens again once something appears.
let autoOpened = false

async function readCached($: EngineInterface, path: string, mtimeMs: number) {
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.text
  const text: string = await $.fs.read(path)
  cache.set(path, { mtimeMs, text })
  return text
}

async function scan($: EngineInterface) {
  const root = `${await $.session.root()}/.scratch`
  const dirs = await $.fs.list(root).catch(() => [])
  const found: Feature[] = []
  const seen: string[] = []

  for (const dir of dirs.filter(d => d.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name))) {
    const base = `${root}/${dir.name}`
    const top = await $.fs.list(base).catch(() => [])
    const feature: Feature = { slug: dir.name, tickets: [] }

    const docEntry = top.find(f => f.name === 'spec.md') ?? top.find(f => f.name === 'map.md')
    if (docEntry) {
      const path = `${base}/${docEntry.name}`
      seen.push(`${path}@${docEntry.mtimeMs}`)
      const text = await readCached($, path, docEntry.mtimeMs)
      feature.doc = {
        file: path,
        title: heading(text).replace(/^(Spec|Map):\s*/i, '') || dir.name,
        status: firstWord(field(text, 'Status') ?? ''),
      }
    }

    const issues = await $.fs.list(`${base}/issues`).catch(() => [])
    for (const f of issues.filter(f => f.kind === 'file' && f.name.endsWith('.md'))) {
      const path = `${base}/issues/${f.name}`
      seen.push(`${path}@${f.mtimeMs}`)
      feature.tickets.push(parseTicket(dir.name, path, f.name, await readCached($, path, f.mtimeMs)))
    }
    if (feature.doc || feature.tickets.length) found.push(feature)
  }

  if (found.length && !autoOpened) {
    autoOpened = true
    void $.ui.open({ id: PANE, title: TITLE })
  } else if (!found.length) {
    // The engine keeps a pane up across reloads, so ask it rather than trusting autoOpened.
    const panes = await $.ui.panes().catch(() => [])
    if (panes.some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE }).catch(() => {})
      autoOpened = false
    }
  }

  const signature = seen.join('|')
  if (signature === lastSignature) return
  lastSignature = signature
  await update($, features, () => found)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tickets',
      description: 'Show the specs and tickets in .scratch/ in a live pane',
    })
    await scan($)
    $.clock.every(POLL_MS, () => void scan($).catch(() => {}))

    return next(e)
  })

  // A /resume or /clear goes on in this process under another session, whose
  // $.state holds no board yet; session.start doesn't fire for it, so rescan
  // here, forgetting the last scan so the new session's state gets filled.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'startup') {
      lastSignature = ''
      await scan($).catch(() => {})
    }
    return result
  })

  on('command.run', { command: 'tickets' }, async $ => {
    // Set first, so the scan does not open the pane as well.
    autoOpened = true
    await scan($)
    if ((await read($, features)).length === 0) {
      autoOpened = false
      return { text: 'No specs or tickets under .scratch/ yet.' }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Ticket board opened.' }
  })

  // Refresh straight after Claude writes into .scratch rather than waiting for the poll.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = (e as any).file_path
    if (typeof path === 'string' && path.includes('/.scratch/')) void scan($).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, features)
    const open = await read($, expanded)
    const hide = await read($, hideDone)
    const mode = await read($, view)

    if (all.length === 0) {
      return <Text dimColor>No specs or tickets under .scratch/ yet.</Text>
    }

    // One queue across every feature rather than a section per feature: each
    // ticket keeps its feature as a column, so the eye reads straight down.
    type Row = { feature: Feature; t: Ticket; rank: number; blocked: boolean; waiting: string[]; byNum: Map<string, Ticket> }
    const rows: Row[] = all.flatMap(feature => {
      const byNum = new Map(feature.tickets.map(t => [t.num, t]))
      return feature.tickets.map(t => ({
        feature,
        t,
        byNum,
        rank: rankOf(t, byNum),
        blocked: isBlocked(t, byNum),
        waiting: t.blockedBy.filter(n => !isFinished(byNum.get(n)?.status ?? 'done')),
      }))
    })
    rows.sort((a, b) => a.rank - b.rank || a.feature.slug.localeCompare(b.feature.slug) || a.t.num.localeCompare(b.t.num))

    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.t.status, (counts.get(r.t.status) ?? 0) + 1)
    const legend = Object.keys(STATUS)
      .filter(s => counts.has(s) && !isFinished(s))
      .sort((a, b) => styleOf(a).rank - styleOf(b).rank)
    const doneCount = rows.filter(r => isFinished(r.t.status)).length

    const nextUp = rows.filter(r => !r.blocked && !isFinished(r.t.status))
    const blockedRows = rows.filter(r => r.blocked)
    const doneRows = hide ? [] : rows.filter(r => isFinished(r.t.status))
    const progress = hide ? all.filter(f => f.tickets.some(t => !isFinished(t.status))) : all

    const slugWidth = Math.max(...all.map(f => f.slug.length)) + 2
    const numWidth = Math.max(2, ...rows.map(r => r.t.num.length)) + 2
    const BAR = 10

    const rule = (label: string, color: string) => (
      <Box flexDirection="row" marginTop={1}>
        <Text color={color}>{'── '}</Text>
        <Text color={color} bold>{label} </Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={color} wrap="truncate-end">{'─'.repeat(200)}</Text>
        </Box>
      </Box>
    )

    const ticketRow = ({ feature, t, blocked, waiting, byNum }: Row, i: number, list: Row[], showSlug = true) => {
      const style = styleOf(t.status)
      const finished = isFinished(t.status)
      const isOpen = open === t.id
      // Repeats of the feature above fade, so a run of one feature's tickets reads as a group.
      const repeat = i > 0 && list[i - 1]!.feature === feature

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={blocked ? 'inactive' : style.color}>{blocked ? '⧗' : style.glyph}</Text>
            </Box>
            {showSlug && (
              <Box width={slugWidth} flexShrink={0}>
                <Text dimColor={repeat || finished} wrap="truncate-end">{feature.slug}</Text>
              </Box>
            )}
            <Box width={numWidth} flexShrink={0}>
              <Text dimColor>{t.num}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Button key={t.id} plain onPress={() => update($, expanded, cur => (cur === t.id ? null : t.id))}>
                <Text dimColor={finished || blocked} strikethrough={t.status === 'wontfix'} wrap="truncate-end">
                  {t.title}
                  {t.type && t.type !== 'task' && <Text dimColor> [{t.type}]</Text>}
                  {blocked && <Text dimColor> ← {waiting.join(', ')}</Text>}
                </Text>
              </Button>
            </Box>
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2 + (showSlug ? slugWidth : 0) + numWidth} marginBottom={1}>
              <Text color={style.color}>{t.status}</Text>
              {t.summary && <Text>{t.summary}</Text>}
              {t.blockedBy.length > 0 && (
                <Text>
                  <Text dimColor>blocked by </Text>
                  {t.blockedBy.map(n => {
                    const dep = byNum.get(n)
                    return <Text color={styleOf(dep?.status ?? '').color}>{n} {dep?.status ?? '?'}  </Text>
                  })}
                </Text>
              )}
              <Text dimColor wrap="truncate-start">{t.file}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const sections = [
      { label: 'next up', color: 'success', rows: nextUp },
      { label: 'blocked', color: 'inactive', rows: blockedRows },
      { label: 'done', color: 'subtle', rows: doneRows },
    ].filter(s => s.rows.length > 0)

    const progressRow = (feature: Feature, heading: boolean) => {
      const done = feature.tickets.filter(t => isFinished(t.status)).length
      const total = feature.tickets.length
      const filled = total ? Math.round((done / total) * BAR) : 0
      const complete = total > 0 && done === total
      const docStyle = styleOf(feature.doc?.status ?? '')

      return (
        <Box flexDirection="row">
          <Box width={2 + slugWidth} flexShrink={0}>
            <Text bold={heading && !complete} dimColor={complete} wrap="truncate-end">{feature.slug}</Text>
          </Box>
          <Box width={BAR + 7} flexShrink={0}>
            <Text color={complete ? 'subtle' : 'success'}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(BAR - filled)} {`${done}/${total}`.padStart(5)}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {feature.doc && (
              <Text dimColor wrap="truncate-end">
                {feature.doc.title}
                {feature.doc.status && <Text color={docStyle.color}> {docStyle.glyph}</Text>}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    // By spec: each spec's progress line heads its own tickets, in the same status order.
    const bySpec = progress.map(feature => (
      <Box flexDirection="column" marginTop={1}>
        {progressRow(feature, true)}
        <Box flexDirection="column" paddingLeft={2}>
          {rows
            .filter(r => r.feature === feature && !(hide && isFinished(r.t.status)))
            .map((r, i, list) => ticketRow(r, i, list, false))}
        </Box>
      </Box>
    ))

    const upcoming = (
      <Box flexDirection="column">
        {sections.map(section => (
          <Box flexDirection="column">
            {rule(section.label, section.color)}
            {section.rows.map((r, i, list) => ticketRow(r, i, list))}
          </Box>
        ))}
        {progress.length > 0 && rule('progress', 'subtle')}
        {progress.map(feature => progressRow(feature, false))}
      </Box>
    )


    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {legend.map(s => (
                <Text color={styleOf(s).color}>{styleOf(s).glyph} {counts.get(s)} {s}   </Text>
              ))}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={2}>
            <Button key="toggle-view" plain hotkey="v" onPress={() => update($, view, v => (v === 'spec' ? 'upcoming' : 'spec'))}>
              <Text bold={mode === 'upcoming'} dimColor={mode !== 'upcoming'}>upcoming</Text>
              <Text dimColor> · </Text>
              <Text bold={mode === 'spec'} dimColor={mode !== 'spec'}>by spec</Text>
            </Button>
          </Box>
          {doneCount > 0 && (
            <Box flexShrink={0} marginLeft={2}>
              <Button key="toggle-done" plain hotkey="d" onPress={() => update($, hideDone, v => !v)}>
                <Text dimColor>{hide ? `show ${doneCount} done` : 'hide done'}</Text>
              </Button>
            </Box>
          )}
        </Box>

        {mode === 'spec' ? bySpec : upcoming}
      </Box>
    )
  })
}
