import type { RawPerceptionEvent } from '../types/raw-events'
import type { PerceptionSignal } from '../types/signals'

/**
 * Entity belief stored in perception context
 */
export interface EntityBelief {
  id: string
  type: 'player' | 'mob' | 'item' | 'block'
  name?: string
  position?: { x: number, y: number, z: number }
  isSneaking?: boolean
  lastUpdatedAt: number
}

/**
 * Saliency counter state (replaces WindowCounter)
 */
export interface CounterState {
  /** Current head position in circular buffer */
  head: number
  /** Event counts per slot */
  counts: number[]
  /** Trigger markers per slot (1 = fired in this slot) */
  triggers: number[]
  /** Running total of counts in window */
  total: number
  /** Slot when last event was received */
  lastEventSlot: number
  /** Slot when threshold was last triggered */
  lastFireSlot: number | null
  /** Total count when last fired */
  lastFireTotal: number
}

/**
 * Perception machine context
 */
export interface PerceptionContext {
  /** Entity beliefs tracked by PerceptionAPI */
  entities: Map<string, EntityBelief>
  /** Saliency counters for threshold detection */
  counters: Map<string, CounterState>
  /** Current slot number for saliency window */
  currentSlot: number
  /** Configuration */
  config: {
    slotMs: number
    windowSize: number
    maxDistance: number
  }
}

/**
 * Events that can be sent to the perception machine
 */
export type PerceptionEvent
  = | { type: 'START' }
    | { type: 'STOP' }
    | { type: 'RAW_EVENT', event: RawPerceptionEvent }
    | { type: 'TICK' }
    | { type: 'EMIT_SIGNAL', signal: PerceptionSignal }

/**
 * Input for creating the perception machine
 */
export interface PerceptionMachineInput {
  slotMs?: number
  windowSize?: number
  maxDistance?: number
  onSignal?: (signal: PerceptionSignal) => void
}
