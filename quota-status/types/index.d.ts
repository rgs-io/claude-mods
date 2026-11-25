export type QuotaLine = string | null

/** List-price dollars the session's transcripts record for the main loop and for all subagents, since it first began. */
export type Spend = { main: number; agents: number }

declare module 'claude-code' {
  interface PluginState {
    'quota-status': { line: QuotaLine; spend: Spend }
  }
}
