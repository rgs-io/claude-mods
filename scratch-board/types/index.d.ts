export type Ticket = {
  id: string
  file: string
  num: string
  title: string
  status: string
  type?: string
  blockedBy: string[]
  summary: string
}

export type Feature = {
  slug: string
  doc?: { file: string; title: string; status: string }
  tickets: Ticket[]
}

declare module 'claude-code' {
  interface PluginState {
    'scratch-board': {
      features: Feature[]
      expanded: string | null
      hideDone: boolean
      view: 'upcoming' | 'spec'
    }
  }
}
