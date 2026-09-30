/**
 * How one event wakes the agent. The producer of the event chooses the mode.
 *
 * - `preempt` delivers now and cancels a model call that has not produced output.
 * - `flush` delivers now together with every queued event.
 * - `debounce` joins a batch that delivers after a quiet gap, an age limit, or a size limit.
 * - `piggyback` waits in the queue and rides with the next batch. It never wakes the agent.
 */
export type TriggerMode = 'preempt' | 'flush' | 'debounce' | 'piggyback'

/** `internal` is only for notices whose source the loop can verify, such as the heartbeat. */
export type EventOrigin = 'external' | 'internal'

/** One thing that happened outside the agent. The text states only what the producer can confirm. */
export interface AgentEvent {
  /** Assigned by the loop when the event is pushed. */
  id: string
  /** Producer-owned name, for example `chat.message` or `game.job_finished`. */
  type: string
  /** Producer identity, for example the plugin id. */
  source: string
  origin: EventOrigin
  /** Wall-clock time in milliseconds when the loop accepted the event. */
  ts: number
  text: string
  /** Image data URLs shown to the model with the event text. */
  images?: string[]
  /** Producer data that the loop passes to observers and never to the model. */
  meta?: Record<string, unknown>
}

/** What a producer supplies. The loop fills `id`, `ts`, and defaults for `origin`. */
export type AgentEventInput = Omit<AgentEvent, 'id' | 'ts' | 'origin'> & Partial<Pick<AgentEvent, 'origin'>>

export interface PushOptions {
  /** Defaults to `flush` for internal events and `debounce` for external events. */
  trigger?: TriggerMode
}

/** Timing of debounce batches. */
export interface WakeBusOptions {
  /** A batch delivers when this much time passed since the last event. */
  quietGapMs: number
  /** A batch waits at least this long after its first event. */
  minBatchAgeMs: number
  /** A batch delivers at this age after its first event, whatever arrives. */
  maxBatchAgeMs: number
  /** A batch delivers at once when this many waking events are queued. */
  maxBatchSize: number
}
