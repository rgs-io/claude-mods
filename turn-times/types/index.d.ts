/** Milliseconds since the epoch. */
export type Stamp = number


declare module 'claude-code' {
  interface PluginState {
    'turn-times': {
      /** When each row of the main conversation was appended, ms since the epoch, by the row's id. */
      at: StateFamily<Stamp>
      /** The same for rows the transcript file held when the session (re)started. */
      loaded: Record<string, number>
      /** The current time, moved on once a minute so the relative times redraw. */
      now: Stamp
      /** The local time zone's offset from UTC in minutes (east positive), as `date +%z` reads it. */
      offset: number
    }
  }
}
