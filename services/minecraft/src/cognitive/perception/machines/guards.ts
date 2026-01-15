import type { SaliencyRule } from '../saliency-rules'
import type { RawPerceptionEvent } from '../types/raw-events'
import type { PerceptionContext } from './types'

/**
 * Check if an event has entity information
 */
export function hasEntityInfo(event: RawPerceptionEvent): boolean {
  return 'entityId' in event && 'entityType' in event
}

/**
 * Check if a counter has reached its threshold
 */
export function hasReachedThreshold(
  context: PerceptionContext,
  key: string,
  threshold: number,
): boolean {
  const counter = context.counters.get(key)
  if (!counter) {
    return false
  }

  return counter.total >= threshold
}

/**
 * Check if a rule's predicate passes
 */
export function rulePredicatePasses(
  event: RawPerceptionEvent,
  rule: SaliencyRule | undefined,
): boolean {
  if (!rule) {
    return false
  }

  if (rule.predicate) {
    return rule.predicate(event)
  }

  return true
}
