import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shot } from '../types'

const PANE = 'screenshots'
const TITLE = 'Screenshots'
const TOOL = 'show_image'
const KEEP = 50

const shots = atom({ plugin: 'screenshots', key: 'shots' } as const, [])
const index = atom({ plugin: 'screenshots', key: 'index' } as const, -1)
// A scale against native size, or null to fit the pane (the default).
const zoom = atom({ plugin: 'screenshots', key: 'zoom' } as const, null)

// The width and height a PNG's IHDR chunk gives, bytes 16 to 23.
function pngSize(base64: string): { width: number; height: number } | null {
  const head = atob(base64.slice(0, 44))
  if (head.slice(1, 4) !== 'PNG' || head.length < 24) {
    return null
  }
  const word = (at: number) =>
    ((head.charCodeAt(at) << 24) |
      (head.charCodeAt(at + 1) << 16) |
      (head.charCodeAt(at + 2) << 8) |
      head.charCodeAt(at + 3)) >>>
    0

  return { width: word(16), height: word(20) }
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

// "9x19" is a cell 9 pixels wide and 19 tall.
function cellPixels(text: unknown): { width: number; height: number } {
  const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(typeof text === 'string' ? text : '')
  const width = Number(match?.[1] ?? 9)
  const height = Number(match?.[2] ?? 19)

  return width > 0 && height > 0 ? { width, height } : { width: 9, height: 19 }
}

// The scale that shows the picture whole in the room given, never past native size.
function fitScale(shot: Shot, cell: { width: number; height: number }, columns: number, rows: number) {
  return Math.min(1, (columns * cell.width) / shot.width, (rows * cell.height) / shot.height)
}

// The box of cells the picture fills at a scale; the site clips what overflows.
function boxAt(shot: Shot, cell: { width: number; height: number }, scale: number) {
  const clamp = (n: number) => Math.max(1, Math.min(255, Math.round(n)))

  return {
    columns: clamp((shot.width * scale) / cell.width),
    rows: clamp((shot.height * scale) / cell.height),
  }
}

async function push(
  $: EngineInterface,
  cwd: string,
  path: string,
  caption?: string,
): Promise<string | null> {
  const full = path.startsWith('/') ? path : `${cwd}/${path}`
  const stat = await $.fs.stat(full).catch(() => null)
  if (stat === null || stat.kind !== 'file') {
    return `No file at ${full}.`
  }
  const { base64 } = await $.fs.read(full, { as: 'bytes' })
  const size = pngSize(base64)
  if (size === null) {
    return `${full} is not a PNG; only PNGs can be shown.`
  }
  const shot: Shot = { path: full, caption, ...size, mtimeMs: stat.mtimeMs }
  let at = 0
  await update($, shots, list => {
    const next = [...list, shot].slice(-KEEP)
    at = next.length - 1
    return next
  })
  await update($, index, () => at)
  void $.ui.open({ id: PANE, title: TITLE })

  return null
}

export const register: Register = (on, options) => {
  let cwd = '/'
  const cell = cellPixels(options.cellPixels)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'screenshots',
      description: 'Open the screenshots pane',
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Shows a PNG image (a screenshot, a rendered design, a chart) to the user in a pane beside the chat, drawn inline in their terminal. Use it whenever you take a screenshot or render something the user should look at, e.g. in a design loop. Give an absolute path, or one relative to the session's working directory, and a short caption saying what it shows.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to a PNG file' },
          caption: { type: 'string', description: 'What the image shows, in a few words' },
        },
        required: ['path'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'screenshots' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Screenshots pane opened.' }
  })

  on('tool.call', { tool: `mcp__screenshots__${TOOL}` }, async ($, e) => {
    const input = e as unknown as { path?: unknown; caption?: unknown }
    if (typeof input.path !== 'string') {
      return { deny: 'path is required.' }
    }
    const caption = typeof input.caption === 'string' ? input.caption : undefined
    const problem = await push($, cwd, input.path, caption)

    return { result: problem ?? `Shown to the user: ${input.path}` }
  }).catch(() => ({ deny: 'screenshots: could not show that image.' }))

  // An agent that reads a PNG to look at it is shown it too.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && /\.png$/i.test(e.file_path)) {
      await push($, cwd, e.file_path).catch(() => null)
    }

    return ran
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'screenshots: its Read hook failed.' },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const list = await read($, shots)
    const at = Math.min(await read($, index), list.length - 1)
    const shot = list[at]

    if (shot === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No screenshots yet.</Text>
          <Text dimColor>Agents show one with {TOOL}, or by reading a PNG.</Text>
        </Box>
      )
    }

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const rows = (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24) - 4
    const fitted = fitScale(shot, cell, columns, rows)
    const scale = (await read($, zoom)) ?? fitted
    const box = boxAt(shot, cell, scale)
    const name = shot.path.split('/').pop() ?? shot.path
    const go = (by: number) =>
      update($, index, i => Math.max(0, Math.min(list.length - 1, i + by)))
    const larger = ZOOMS.find(z => z > scale + 0.001)
    const smaller = ZOOMS.findLast(z => z < scale - 0.001)
    const zoomTo = (to: number | null) => update($, zoom, () => to)

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="prev" label="‹" hotkey="p" onPress={() => go(-1)} />
          <Text>
            {' '}
            {at + 1}/{list.length}{' '}
          </Text>
          <Button key="next" label="›" hotkey="l" onPress={() => go(1)} />
          <Text dimColor> {name}</Text>
        </Box>
        <Box>
          <Button key="out" label="−" hotkey="o" onPress={() => zoomTo(smaller ?? scale)} />
          <Text> {Math.round(scale * 100)}% </Text>
          <Button key="in" label="+" hotkey="i" onPress={() => zoomTo(larger ?? scale)} />
          <Text> </Text>
          <Button key="fit" label="Fit" hotkey="f" onPress={() => zoomTo(null)} />
          <Text> </Text>
          <Button key="native" label="1:1" hotkey="n" onPress={() => zoomTo(1)} />
          <Text dimColor>
            {' '}
            {shot.width}×{shot.height}
          </Text>
        </Box>
        {shot.caption !== undefined && <Text>{shot.caption}</Text>}
        {'Image' in ui ? (
          <ui.Image
            source={{ file: shot.path, format: 'png', generation: Math.floor(shot.mtimeMs) }}
            columns={box.columns}
            rows={box.rows}
            alt={shot.caption ?? name}
          />
        ) : (
          <Text dimColor>{shot.path}</Text>
        )}
      </Box>
    )
  })
}
