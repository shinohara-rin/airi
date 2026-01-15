import type { ConsciousMachineContext } from './types'

/**
 * Check if there are queued events to process
 */
export function hasQueuedEvents(context: ConsciousMachineContext): boolean {
  return context.eventQueue.length > 0
}

/**
 * Check if should retry after LLM error
 */
export function shouldRetry(context: ConsciousMachineContext, maxRetries: number): boolean {
  return context.retryCount < maxRetries
}

/**
 * Check if all actions are done
 */
export function allActionsDone(context: ConsciousMachineContext): boolean {
  return context.pendingActions.size === 0 && context.inFlightActions.size === 0
}

/**
 * Check if there are pending actions to execute
 */
export function hasPendingActions(context: ConsciousMachineContext): boolean {
  return context.pendingActions.size > 0
}
