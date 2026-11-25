import { expect, test } from 'claude-code/testing'

const FILES: Record<string, string> = {
  '/p/.scratch/feat/spec.md': '# Spec: The feature\n\nStatus: ready-for-agent\n',
  '/p/.scratch/feat/issues/01-first.md': '# 01: First\n\n**Blocked by:** None\n\n**Status:** done\n',
  '/p/.scratch/feat/issues/02-second.md': '# 02: Second\n\n**Blocked by:** 01 (First)\n\n**Status:** ready-for-human\n',
  '/p/.scratch/feat/issues/03-third.md': '# 03: Third\n\n**What to build:** The third thing.\n\n**Blocked by:** 01 (First)\n\n**Status:** ready-for-agent\n',
  '/p/.scratch/feat/issues/04-fourth.md': '# 04: Fourth\n\n**Blocked by:** 02 (Second), 01\n\n**Status:** ready-for-agent\n',
  '/p/.scratch/feat/issues/05-fifth.md': '# 05: Fifth\n\nStatus: needs-triage\n',
}

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })

const PANE = {
  plugin: 'scratch-board',
  component: 'Pane',
  requestId: 'scratch-board',
  props: {
    title: 'Tickets',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('one queue across features: sorted by status, blocked drop, done hides behind a toggle', async ($, on) => {
  on('command.register', () => ({ value: { command: 'tickets' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/p' }))
  on('fs.list', (_, e) => {
    const dir = e.path ?? '/p'
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(FILES)) {
      if (!path.startsWith(`${dir}/`)) continue
      const [head, ...rest] = path.slice(dir.length + 1).split('/')
      names.set(head!, rest.length ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error('ENOENT')
    return { value: [...names].map(([name, kind]) => entry(name, kind)) }
  })
  on('fs.read', (_, e) => ({ value: FILES[e.path]! }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const titles = async () => (await ui.findAll({ type: 'Button', text: /^(First|Second|Third|Fourth|Fifth)/ })).map(r => r.text?.split(' ')[0])
    const rules = async () => (await ui.findAll({ type: 'Text', text: /^(next up|blocked|done|progress) $/ })).map(r => r.text?.trim())

    // Done tickets hide by default; the toggle names how many there are.
    expect(await titles()).toEqual(['Third', 'Second', 'Fifth', 'Fourth'])
    expect(await rules()).toEqual(['next up', 'blocked', 'progress'])
    expect(await ui.find({ type: 'Text', text: /show 1 done/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /← 02/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /The feature/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1\/5/ })).toBeTruthy()

    await ui.press({ key: 'toggle-done' })
    expect(await titles()).toEqual(['Third', 'Second', 'Fifth', 'Fourth', 'First'])
    expect(await rules()).toEqual(['next up', 'blocked', 'done', 'progress'])
    await ui.press({ key: 'toggle-done' })

    // By spec: no section rules, the spec heads its tickets, same status order.
    await ui.press({ key: 'toggle-view' })
    expect(await rules()).toEqual([])
    expect(await titles()).toEqual(['Third', 'Second', 'Fifth', 'Fourth'])
    expect(await ui.find({ type: 'Text', text: /^feat$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /The feature/ })).toBeTruthy()
    await ui.press({ key: 'toggle-view' })
    expect(await rules()).toEqual(['next up', 'blocked', 'progress'])

    await ui.press({ key: 'feat/03' })
    expect(await ui.find({ type: 'Text', text: /The third thing/ })).toBeTruthy()
    await ui.press({ key: 'feat/03' })
    expect(await ui.find({ type: 'Text', text: /The third thing/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the pane stays shut when .scratch has nothing, and opens once tickets appear', async ($, on) => {
  const files: Record<string, string> = {}
  let opens = 0
  on('command.register', () => ({ value: { command: 'tickets' } }))
  on('ui.open', () => {
    opens++
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/p' }))
  on('fs.list', (_, e) => {
    const dir = e.path ?? '/p'
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) continue
      const [head, ...rest] = path.slice(dir.length + 1).split('/')
      names.set(head!, rest.length ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error('ENOENT')
    return { value: [...names].map(([name, kind]) => entry(name, kind)) }
  })
  on('fs.read', (_, e) => ({ value: files[e.path]! }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(opens).toBe(0)

  Object.assign(files, FILES)
  await $.command.run({ command: 'tickets' } as any)
  expect(opens).toBe(1)
})

test('an open pane closes when .scratch empties, and /tickets with nothing opens no pane', async ($, on) => {
  let opens = 0
  const closes: string[] = []
  on('command.register', () => ({ value: { command: 'tickets' } }))
  on('ui.open', () => {
    opens++
    return { value: { isPlaced: true } }
  })
  // Left up from before a reload: the engine still lists it.
  on('ui.panes', () => ({ value: [{ id: 'scratch-board', title: 'Tickets', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.close', (_, e) => {
    closes.push(e.id)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/p' }))
  on('fs.list', () => {
    throw new Error('ENOENT')
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(closes).toEqual(['scratch-board'])

  const ran = await $.command.run({ command: 'tickets' } as any)
  expect(opens).toBe(0)
  expect(JSON.stringify(ran)).toContain('No specs or tickets')
})

test('a /resume in the process fills the new session\'s board from the same files', async ($, on) => {
  on('command.register', () => ({ value: { command: 'tickets' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/p' }))
  on('fs.list', (_, e) => {
    const dir = e.path ?? '/p'
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(FILES)) {
      if (!path.startsWith(`${dir}/`)) continue
      const [head, ...rest] = path.slice(dir.length + 1).split('/')
      names.set(head!, rest.length ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error('ENOENT')
    return { value: [...names].map(([name, kind]) => entry(name, kind)) }
  })
  on('fs.read', (_, e) => ({ value: FILES[e.path]! }))

  on('classic.SessionStart', () => ({}) as any)
  let writes = 0
  on('state.set', (_: any, e: any, next: any) => {
    if (e.key === 'features') writes++
    return next(e)
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(writes).toBe(1)
  // The resumed session's state starts empty, so the board is written to it
  // again though the files haven't changed.
  await $.classic.SessionStart({ source: 'resume' } as any)
  expect(writes).toBe(2)
  // A startup is session.start's to handle, not this hook's.
  await $.classic.SessionStart({ source: 'startup' } as any)
  expect(writes).toBe(2)
})
