import type { AgentEvent, PushOptions, TriggerMode, WakeBusOptions } from './types'

interface Queued {
  event: AgentEvent
  /** Fixed when queued so later counting and scheduling keep the same view. */
  piggyback: boolean
}

/**
 * Delivers queued events to one consumer in arrival order.
 *
 * State model: the queue, the batch timer, the pause flag and one waiting consumer are runtime state.
 * Nothing is persisted. The delivery time of a debounce batch is
 * `min(first + maxBatchAge, max(first + minBatchAge, last + quietGap))`.
 * `piggyback` events never start a timer and never count toward the size limit, and they alone cannot
 * cause a delivery.
 */
export class WakeBus {
  private queue: Queued[] = []
  private paused = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private firstAt: number | undefined
  private lastAt = 0
  private waiter: ((batch: AgentEvent[]) => void) | undefined
  /** A delivery condition was met while no consumer waited. The next consumer takes the batch at once. */
  private ready = false
  private preemptHandler: (() => void) | undefined

  constructor(private readonly options: WakeBusOptions) {}

  /** The handler only reports the mechanical moment. The loop decides whether cancelling is still safe. */
  setPreemptHandler(handler: () => void) {
    this.preemptHandler = handler
  }

  push(event: AgentEvent, options: PushOptions = {}) {
    const trigger: TriggerMode = options.trigger ?? (event.origin === 'internal' ? 'flush' : 'debounce')
    const piggyback = trigger === 'piggyback'
    this.queue.push({ event, piggyback })

    if (piggyback)
      return

    if (trigger === 'preempt') {
      const permitted = !this.paused
      this.deliver()
      if (permitted)
        this.preemptHandler?.()
      return
    }

    if (trigger === 'flush') {
      this.deliver()
      return
    }

    const now = Date.now()
    this.firstAt ??= now
    this.lastAt = now
    if (this.countWaking() >= this.options.maxBatchSize) {
      this.deliver()
      return
    }
    this.arm()
  }

  /** Puts events that a cancelled turn already took back in front of the queue. They wake the agent again. */
  requeue(events: AgentEvent[]) {
    if (events.length === 0)
      return
    this.queue.unshift(...events.map(event => ({ event, piggyback: false })))
    this.deliver()
  }

  /** While paused, events are queued and nothing delivers. Resuming delivers the backlog at once. */
  setPaused(paused: boolean) {
    this.paused = paused
    if (!paused && this.queue.length > 0)
      this.deliver()
  }

  /** Waking events waiting in the queue. The loop reads it to tell whether it is idle. */
  pendingWaking() {
    return this.countWaking()
  }

  /** Takes the whole queue when a delivery condition is met. Only one consumer can wait at a time. */
  nextBatch(): Promise<AgentEvent[]> {
    if (this.waiter)
      throw new Error('WakeBus supports one consumer')

    if (this.ready && this.queue.length > 0 && !this.paused) {
      this.ready = false
      return Promise.resolve(this.take())
    }

    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  dispose() {
    this.clearTimer()
    this.waiter = undefined
    this.queue = []
    this.ready = false
  }

  private arm() {
    if (this.firstAt === undefined)
      return

    const { quietGapMs, minBatchAgeMs, maxBatchAgeMs } = this.options
    const at = Math.min(
      this.firstAt + maxBatchAgeMs,
      Math.max(this.firstAt + minBatchAgeMs, this.lastAt + quietGapMs),
    )
    this.clearTimer()
    this.timer = setTimeout(() => this.deliver(), Math.max(0, at - Date.now()))
  }

  private deliver() {
    this.clearTimer()

    // An empty queue, or one with only piggyback events, has nothing that may wake the agent.
    if (this.countWaking() === 0)
      return

    if (this.paused) {
      this.ready = true
      return
    }

    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      this.ready = false
      waiter(this.take())
      return
    }

    this.ready = true
  }

  private take() {
    const batch = this.queue.map(item => item.event)
    this.queue = []
    // The next batch times its minimum and maximum age from its own first event.
    this.firstAt = undefined
    return batch
  }

  private countWaking() {
    return this.queue.reduce((count, item) => count + (item.piggyback ? 0 : 1), 0)
  }

  private clearTimer() {
    if (this.timer)
      clearTimeout(this.timer)
    this.timer = undefined
  }
}
