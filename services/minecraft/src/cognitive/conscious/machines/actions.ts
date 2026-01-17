import type { ActionInstruction } from '../../action/types'
import type { BotEvent } from '../../types'
import type { BlackboardState } from '../types'
import { updateBlackboard as opUpdateBlackboard } from '../blackboard-ops'
import type { ConsciousMachineContext, LLMResponse } from './types'

/**
 * Enqueue a new event
 */
export function enqueueEvent(
  context: ConsciousMachineContext,
  event: BotEvent,
): ConsciousMachineContext {
  return {
    ...context,
    eventQueue: [...context.eventQueue, event],
  }
}

/**
 * Dequeue the next event
 */
export function dequeueEvent(
  context: ConsciousMachineContext,
): ConsciousMachineContext {
  const [event, ...rest] = context.eventQueue

  return {
    ...context,
    eventQueue: rest,
    currentEvent: event ?? null,
  }
}

/**
 * Clear current event
 */
export function clearCurrentEvent(
  context: ConsciousMachineContext,
): ConsciousMachineContext {
  return {
    ...context,
    currentEvent: null,
  }
}

/**
 * Update blackboard from LLM response
 */
export function updateBlackboard(
  context: ConsciousMachineContext,
  response: LLMResponse,
): ConsciousMachineContext {
  const updates: Partial<BlackboardState> = {}

  if (response.blackboard?.UltimateGoal) {
    updates.ultimateGoal = response.blackboard.UltimateGoal
  }
  if (response.blackboard?.CurrentTask) {
    updates.currentTask = response.blackboard.CurrentTask
  }
  if (response.blackboard?.executionStrategy) {
    updates.strategy = response.blackboard.executionStrategy
  }

  return {
    ...context,
    blackboard: opUpdateBlackboard(context.blackboard, updates),
    lastResponse: response,
  }
}

/**
 * Assign IDs to actions and add to pending
 */
export function addPendingActions(
  context: ConsciousMachineContext,
  actions: ActionInstruction[],
): ConsciousMachineContext {
  const newPendingActions = new Map(context.pendingActions)
  let nextActionId = context.nextActionId

  for (const action of actions) {
    const actionWithId = action.id
      ? action
      : { ...action, id: `action-${nextActionId++}` }

    newPendingActions.set(actionWithId.id!, actionWithId)
  }

  return {
    ...context,
    pendingActions: newPendingActions,
    nextActionId,
  }
}

/**
 * Mark action as started (move to in-flight)
 */
export function markActionStarted(
  context: ConsciousMachineContext,
  actionId: string,
): ConsciousMachineContext {
  const newInFlight = new Set(context.inFlightActions)
  newInFlight.add(actionId)

  return {
    ...context,
    inFlightActions: newInFlight,
  }
}

/**
 * Mark action as completed (remove from in-flight and pending)
 */
export function markActionCompleted(
  context: ConsciousMachineContext,
  actionId: string,
): ConsciousMachineContext {
  const newPendingActions = new Map(context.pendingActions)
  newPendingActions.delete(actionId)

  const newInFlight = new Set(context.inFlightActions)
  newInFlight.delete(actionId)

  return {
    ...context,
    pendingActions: newPendingActions,
    inFlightActions: newInFlight,
  }
}

/**
 * Increment retry count
 */
export function incrementRetry(
  context: ConsciousMachineContext,
): ConsciousMachineContext {
  return {
    ...context,
    retryCount: context.retryCount + 1,
  }
}

/**
 * Reset retry count
 */
export function resetRetry(
  context: ConsciousMachineContext,
): ConsciousMachineContext {
  return {
    ...context,
    retryCount: 0,
  }
}

/**
 * Clear all pending and in-flight actions
 */
export function clearAllActions(
  context: ConsciousMachineContext,
): ConsciousMachineContext {
  return {
    ...context,
    pendingActions: new Map(),
    inFlightActions: new Set(),
  }
}
