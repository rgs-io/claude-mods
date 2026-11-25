import { expect, test } from 'claude-code/testing'

// A 1600x1000 PNG's first 24 bytes, IHDR included.
const SMALL = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 114, 0, 0, 0, 88]
const HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x06, 0x40, 0, 0, 0x03, 0xe8]
const PNG = btoa(String.fromCharCode(...HEAD, 8, 6, 0, 0, 0))

const PANE = {
  plugin: 'screenshots',
  component: 'Pane',
  requestId: 'screenshots',
  surface: 'terminal',
  props: {
    title: 'Screenshots',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('show_image draws the PNG in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'screenshots' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__screenshots__show_image' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 29, mtimeMs: 7.25, isLink: false } }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({
    tool: 'mcp__screenshots__show_image',
    path: 'shots/home.png',
    caption: 'Home page',
  })
  expect(ran.result).toBe('Shown to the user: shots/home.png')

  const ui = await $.ui.mount(PANE)
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ file: '/work/shots/home.png', format: 'png', generation: 7 })
  // Fit: 1600 px into 60 cells of 9 px is a scale of 0.3375.
  expect(image?.props.columns).toBe(60)
  expect(image?.props.rows).toBe(18)

  await ui.press({ key: 'in' })
  const zoomed = await ui.find({ type: 'Image' })
  expect(zoomed?.props.columns).toBe(89)
  expect(zoomed?.props.rows).toBe(26)

  await ui.press({ key: 'native' })
  const native = await ui.find({ type: 'Image' })
  expect(native?.props.columns).toBe(178)
  await ui.unmount()
})

test('a small image fits at its native size, not stretched', async ($, on) => {
  on('command.register', () => ({ value: { command: 'screenshots' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__screenshots__show_image' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 29, mtimeMs: 7, isLink: false } }))
  on('fs.read', () => ({ value: { base64: btoa(String.fromCharCode(...SMALL, 8, 6, 0, 0, 0)) } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__screenshots__show_image', path: '/work/mark.png' })

  const ui = await $.ui.mount(PANE)
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.columns).toBe(13)
  expect(image?.props.rows).toBe(5)
  await ui.unmount()
})
