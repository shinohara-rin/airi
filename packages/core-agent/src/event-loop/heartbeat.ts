/** Upper limit of the quiet-beat backoff, as a multiple of the base interval. */
const MAX_BACKOFF = 8

/**
 * Calls `onBeat` after the base interval, and doubles the interval for each quiet beat up to
 * {@link MAX_BACKOFF} times the base. Any activity resets it.
 *
 * A beat is quiet when no activity happened since the previous beat. The heartbeat owns its timer.
 * `start` twice is harmless. `stop` clears the timer and later beats do not fire.
 */
export class Heartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private lastActivity = Date.now()
  private lastBeat = 0
  private quietBeats = 0

  constructor(
    /** Base interval in milliseconds. Returns `undefined` to pause beats while the value stays that way. */
    private readonly baseMs: () => number | undefined,
    private readonly onBeat: (quietSeconds: number) => void,
  ) {}

  noteActivity() {
    this.lastActivity = Date.now()
    this.quietBeats = 0
  }

  start() {
    if (this.running)
      return
    this.running = true
    this.arm()
  }

  stop() {
    this.running = false
    if (this.timer)
      clearTimeout(this.timer)
    this.timer = undefined
  }

  private delay() {
    const base = this.baseMs()
    return base === undefined ? undefined : base * Math.min(2 ** this.quietBeats, MAX_BACKOFF)
  }

  private arm() {
    if (!this.running)
      return

    if (this.timer)
      clearTimeout(this.timer)

    // With no base interval the setting is re-read once a minute, so a later change takes effect.
    this.timer = setTimeout(() => this.beat(), this.delay() ?? 60_000)
  }

  private beat() {
    if (!this.running)
      return

    if (this.delay() !== undefined) {
      // A beat with no activity since the previous one counts as quiet and lengthens the next interval.
      this.quietBeats = this.lastActivity > this.lastBeat ? 0 : Math.min(this.quietBeats + 1, Math.log2(MAX_BACKOFF))
      this.lastBeat = Date.now()
      this.onBeat(Math.max(0, Math.round((Date.now() - this.lastActivity) / 1000)))
    }
    this.arm()
  }
}
