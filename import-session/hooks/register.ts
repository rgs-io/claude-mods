import type { EngineInterface, Register } from 'claude-code'

// /import-session                  list this project's sessions in the other profiles
// /import-session --others         also list the folded "other" profiles
// /import-session <pick>           import one: its number, a uuid prefix or words of its title
// /import-session <pick> --force   copy again over an earlier import
// /import-session <pick> --no-resume   import without switching to it (autoResume on)

const COMMAND = 'import-session'
const SHOWN = 20

type Profile = { name: string; dir: string }
type Listed = { id: string; mtime: number; size: number; title: string }
type Entry = Listed & { profile: Profile; n: number }

// One line per session, newest first: id \t mtime \t size \t last title record.
const LIST_SCRIPT = `
cd "$1" 2>/dev/null || exit 3
ls -t -- *.jsonl 2>/dev/null | while IFS= read -r f; do
  id="\${f%.jsonl}"
  mt=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")
  sz=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f")
  t=$(grep -h '"type":"custom-title"' "$f" | tail -n 1)
  [ -n "$t" ] || t=$(grep -h '"type":"ai-title"' "$f" | tail -n 1)
  printf '%s\\t%s\\t%s\\t%s\\n' "$id" "$mt" "$sz" "$t"
done
`

// Every ~/.claude* dir that holds a projects folder.
const DISCOVER_SCRIPT = `
for d in "$1"/.claude "$1"/.claude-*; do [ -d "$d/projects" ] && printf '%s\\n' "$d"; done
exit 0
`

// $1 source project dir, $2 dest project dir, $3 id, $4 source config dir, $5 dest config dir
const COPY_SCRIPT = `
set -e
mkdir -p "$2"
cp -p "$1/$3.jsonl" "$2/$3.jsonl"
if [ -d "$1/$3" ]; then rm -rf "$2/$3"; cp -Rp "$1/$3" "$2/$3"; fi
if [ -d "$4/file-history/$3" ]; then
  mkdir -p "$5/file-history"; rm -rf "$5/file-history/$3"; cp -Rp "$4/file-history/$3" "$5/file-history/$3"
fi
`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const slugOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const strip = (dir: string) => dir.replace(/\/+$/, '')
const nameOf = (dir: string) => (dir.split('/').pop() ?? dir).replace(/^\./, '')

// "claude-work" -> ~/.claude-work, "~/x" -> $HOME/x, "/abs" stays.
function parseProfiles(spec: unknown, home: string): Profile[] {
  if (typeof spec !== 'string') return []

  return spec
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const dir = strip(s.startsWith('/') ? s : s.startsWith('~') ? `${home}${s.slice(1)}` : `${home}/.${s.replace(/^\./, '')}`)

      return { name: nameOf(dir), dir }
    })
}

// "claude=🔑, claude-work=💼" -> { claude: '🔑', 'claude-work': '💼' }
function parseEmoji(spec: unknown): Record<string, string> {
  if (typeof spec !== 'string') return {}
  const out: Record<string, string> = {}
  for (const pair of spec.split(/[,\n]/)) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const name = nameOf(pair.slice(0, at).trim())
    const emoji = pair.slice(at + 1).trim()
    if (name && emoji) out[name] = emoji
  }

  return out
}

async function currentProfile($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const here = strip((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`)

  return { home, here }
}

async function list($: EngineInterface, dir: string): Promise<Listed[]> {
  const ran = await $.process.run(['sh', '-c', LIST_SCRIPT, 'list', dir], { timeoutMs: 60_000 })
  if (ran.exitCode !== 0) return []

  return ran.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [id = '', mtime = '0', size = '0', record = ''] = line.split('\t')
      let title = ''
      try {
        const parsed = JSON.parse(record) as { customTitle?: string; aiTitle?: string }
        title = parsed.customTitle ?? parsed.aiTitle ?? ''
      } catch {}

      return { id, mtime: Number(mtime), size: Number(size), title }
    })
    .filter(one => UUID.test(one.id))
}

const when = (seconds: number) => {
  const d = new Date(seconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const sizeOf = (bytes: number) =>
  bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)}M` : `${Math.max(1, Math.round(bytes / 1024))}k`

function pick(entries: Entry[], query: string): Entry | string {
  if (/^\d+$/.test(query)) {
    return entries.find(one => one.n === Number(query)) ?? `There is no session #${query}.`
  }
  const q = query.toLowerCase()
  const byId = entries.filter(one => one.id.startsWith(q))
  const matches = byId.length > 0 ? byId : entries.filter(one => one.title.toLowerCase().includes(q))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) return `No session matches "${query}".`

  return `"${query}" matches ${matches.length} sessions; use its number from /${COMMAND} (--others lists the folded ones too).`
}

// Runs /resume once the import command has returned, so the switch doesn't
// happen inside the command's own dispatch.
function resumeSoon($: EngineInterface, id: string) {
  $.clock.after(50, () => {
    $.command.run({ command: 'resume', args: id }).catch(() => {
      void $.ui.toast(`Couldn't resume automatically; run /resume ${id}`)
    })
  })
}

export const register: Register = (on, options) => {
  const emoji = parseEmoji(options.profileEmoji)
  const badge = (name: string) => (emoji[name] ? `${emoji[name]} ${name}` : name)

  // The current profile, drawn at the end of the hint line under the prompt
  // (where "auto mode on" shows). Set at session.start, which a reload reruns.
  let profileLabel: string | undefined

  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    if (options.showProfile !== false) {
      const { here } = await currentProfile($)
      profileLabel = badge(nameOf(here))
    }
    await $.command.register({
      name: COMMAND,
      description: 'Import a session for this project from another Claude profile (no args lists them)',
    })

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (!profileLabel) return next(e)
    // After what other mods added (quota-status puts its own in front), with
    // the same separator, so the order of plugins doesn't change the line.
    const tail = e.props.tail ? `${e.props.tail}  │  ${profileLabel}` : profileLabel

    return next({ ...e, props: { ...e.props, tail } })
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const { home, here } = await currentProfile($)
    const tilde = (dir: string) => (home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir)
    const project = `projects/${slugOf(await $.session.cwd())}`

    const main = parseProfiles(options.profiles, home).filter(p => p.dir !== here)
    let others = parseProfiles(options.otherProfiles, home)
    if (others.length === 0) {
      const found = await $.process.run(['sh', '-c', DISCOVER_SCRIPT, 'discover', home])
      others = found.stdout.split('\n').filter(Boolean).map(dir => ({ name: nameOf(dir), dir: strip(dir) }))
    }
    others = others.filter(p => p.dir !== here && !main.some(m => m.dir === p.dir))

    // Number the main profiles' sessions first, then the others', so a number
    // means the same session whether or not the others are shown.
    const gather = async (profiles: Profile[], start: number) => {
      const lists = await Promise.all(profiles.map(p => list($, `${p.dir}/${project}`)))
      const all = profiles
        .flatMap((profile, i) => (lists[i] ?? []).map(one => ({ ...one, profile, n: 0 })))
        .sort((a, b) => b.mtime - a.mtime)
      all.forEach((one, i) => (one.n = start + i + 1))

      return all
    }
    const [mainEntries, ours] = await Promise.all([gather(main, 0), list($, `${here}/${project}`)])
    const otherEntries = await gather(others, mainEntries.length)
    const entries = [...mainEntries, ...otherEntries]
    const mine = new Map(ours.map(one => [one.id, one]))

    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const force = words.includes('--force')
    const showOthers = words.includes('--others') || words.includes('--all')
    const resume = options.autoResume === false ? words.includes('--resume') : !words.includes('--no-resume')
    const query = words.filter(w => !w.startsWith('--')).join(' ')

    if (!query) {
      const row = (one: Entry) => {
        const have = mine.get(one.id)
        const mark = !have ? '' : one.mtime > have.mtime ? '  [imported, newer there]' : '  [imported]'

        return `${String(one.n).padStart(3)}. ${when(one.mtime)}  ${sizeOf(one.size).padStart(6)}  ${badge(one.profile.name).padEnd(width)}  ${one.title || '(untitled)'}  ${one.id.slice(0, 8)}${mark}`
      }
      const shown = showOthers ? entries : mainEntries
      const width = Math.max(0, ...shown.map(one => badge(one.profile.name).length))
      const section = (title: string, list: Entry[]) => {
        if (list.length === 0) return `${title}: none`
        const more = list.length > SHOWN ? `\n     … ${list.length - SHOWN} older` : ''

        return `${title}:\n${list.slice(0, SHOWN).map(row).join('\n')}${more}`
      }

      const out = [
        `You are in ${badge(nameOf(here))} (${tilde(here)}).`,
        section(`Sessions for this project in ${main.map(p => tilde(p.dir)).join(', ') || '(no profiles)'}`, mainEntries),
      ]
      if (others.length > 0) {
        if (showOthers) {
          out.push(section(`Others (${others.map(p => tilde(p.dir)).join(', ')})`, otherEntries))
        } else {
          const counts = others.map(p => `${badge(p.name)} ${otherEntries.filter(one => one.profile === p).length}`)
          out.push(`Others, folded: ${counts.join(', ')}. Show them with /${COMMAND} --others.`)
        }
      }
      out.push(`Import one with /${COMMAND} <number>.`)

      return { text: out.join('\n\n'), isTextDisplayOnly: true }
    }

    const chosen = pick(entries, query)
    if (typeof chosen === 'string') return { text: chosen, isTextDisplayOnly: true }

    const from = chosen.profile
    const label = chosen.title || chosen.id
    const have = mine.get(chosen.id)
    if (have && !force) {
      const stale = chosen.mtime > have.mtime
      const note = stale
        ? `It has changed in ${tilde(from.dir)} since; add --force to copy it again (this overwrites the copy here).`
        : 'It is up to date.'
      // Resume an up-to-date copy; a stale one waits for the person to pick.
      if (resume && !stale) {
        resumeSoon($, chosen.id)

        return { text: `"${label}" is already imported and up to date. Resuming it…`, isTextDisplayOnly: true }
      }

      return { text: `"${label}" is already imported. ${note}\nResume it with /resume ${chosen.id}`, isTextDisplayOnly: true }
    }

    const ran = await $.process.run(
      ['sh', '-c', COPY_SCRIPT, 'copy', `${from.dir}/${project}`, `${here}/${project}`, chosen.id, from.dir, here],
      { timeoutMs: 120_000 },
    )
    if (ran.exitCode !== 0) {
      return { text: `Copying "${label}" failed: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`, isTextDisplayOnly: true }
    }

    if (resume) {
      resumeSoon($, chosen.id)

      return {
        text: `Imported "${label}" from ${tilde(from.dir)}. Resuming it… (if it doesn't switch, run /resume ${chosen.id})`,
        isTextDisplayOnly: true,
      }
    }

    return {
      text: `Imported "${label}" from ${tilde(from.dir)}.\nResume it with /resume ${chosen.id} (or pick "${label}" in /resume).`,
      isTextDisplayOnly: true,
    }
  })
}
