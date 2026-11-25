export type Shot = {
  path: string
  caption?: string
  width: number
  height: number
  mtimeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    screenshots: { shots: Shot[]; index: number; zoom: number | null }
  }
}
