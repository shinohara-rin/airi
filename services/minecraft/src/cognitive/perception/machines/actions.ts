import type { RawPerceptionEvent } from '../types/raw-events'
import type { CounterState, EntityBelief, PerceptionContext } from './types'

import { WINDOW_SIZE } from '../saliency-rules'

/**
 * Update or create entity belief from raw event
 */
export function updateEntityBelief(
  context: PerceptionContext,
  event: RawPerceptionEvent,
): PerceptionContext {
  // Only process events that have entity information
  if (!('entityId' in event) || !('entityType' in event)) {
    return context
  }

  const entityRaw = event as RawPerceptionEvent & {
    entityId: string
    entityType: string
    displayName?: string
    pos?: { x: number, y: number, z: number }
    sneaking?: boolean
  }

  // Determine entity type
  let type: EntityBelief['type'] = 'mob'
  if (entityRaw.entityType === 'player')
    type = 'player'

  const belief: EntityBelief = {
    id: entityRaw.entityId,
    type,
    name: entityRaw.displayName,
    position: entityRaw.pos,
    isSneaking: entityRaw.sneaking,
    lastUpdatedAt: Date.now(),
  }

  const newEntities = new Map(context.entities)
  newEntities.set(entityRaw.entityId, belief)

  return {
    ...context,
    entities: newEntities,
  }
}

/**
 * Increment counter for a specific event key
 */
export function incrementCounter(
  context: PerceptionContext,
  key: string,
): PerceptionContext {
  const counter = context.counters.get(key)
  if (!counter) {
    return context
  }

  // Increment count in current slot
  const newCounts = [...counter.counts]
  newCounts[counter.head] = (newCounts[counter.head] ?? 0) + 1

  const updatedCounter: CounterState = {
    ...counter,
    counts: newCounts,
    total: counter.total + 1,
    lastEventSlot: context.currentSlot,
  }

  const newCounters = new Map(context.counters)
  newCounters.set(key, updatedCounter)

  return {
    ...context,
    counters: newCounters,
  }
}

/**
 * Mark that a threshold was triggered for a counter
 */
export function markThresholdTriggered(
  context: PerceptionContext,
  key: string,
): PerceptionContext {
  const counter = context.counters.get(key)
  if (!counter) {
    return context
  }

  const newTriggers = [...counter.triggers]
  newTriggers[counter.head] = 1

  const updatedCounter: CounterState = {
    ...counter,
    triggers: newTriggers,
    lastFireSlot: context.currentSlot,
    lastFireTotal: counter.total,
  }

  const newCounters = new Map(context.counters)
  newCounters.set(key, updatedCounter)

  return {
    ...context,
    counters: newCounters,
  }
}

/**
 * Reset counter counts after threshold triggered
 */
export function resetCounter(
  context: PerceptionContext,
  key: string,
): PerceptionContext {
  const counter = context.counters.get(key)
  if (!counter) {
    return context
  }

  const updatedCounter: CounterState = {
    ...counter,
    total: 0,
    counts: new Array(WINDOW_SIZE).fill(0),
    // Don't reset triggers - they're visual markers
  }

  const newCounters = new Map(context.counters)
  newCounters.set(key, updatedCounter)

  return {
    ...context,
    counters: newCounters,
  }
}

/**
 * Advance the saliency window by one slot
 */
export function advanceSlot(context: PerceptionContext): PerceptionContext {
  const newSlot = context.currentSlot + 1
  const newCounters = new Map<string, CounterState>()

  for (const [key, counter] of context.counters.entries()) {
    // Move head forward in circular buffer
    const newHead = (counter.head + 1) % WINDOW_SIZE

    // Subtract expired slot from total
    const expired = counter.counts[newHead] ?? 0
    const newTotal = Math.max(0, counter.total - expired)

    // Create new counter with advanced state
    const newCounts = [...counter.counts]
    newCounts[newHead] = 0

    const newTriggers = [...counter.triggers]
    newTriggers[newHead] = 0

    newCounters.set(key, {
      ...counter,
      head: newHead,
      counts: newCounts,
      triggers: newTriggers,
      total: newTotal,
    })
  }

  return {
    ...context,
    currentSlot: newSlot,
    counters: newCounters,
  }
}

/**
 * Create initial counter state
 */
export function createCounter(): CounterState {
  return {
    head: 0,
    counts: new Array(WINDOW_SIZE).fill(0),
    triggers: new Array(WINDOW_SIZE).fill(0),
    total: 0,
    lastEventSlot: 0,
    lastFireSlot: null,
    lastFireTotal: 0,
  }
}
