import type { ActionInstruction } from '../../action/types'
import type { BotEvent } from '../../types'
import type { BlackboardState } from '../blackboard'

/**
 * Conscious machine states
 */
export type ConsciousState = 'idle' | 'thinking' | 'deciding' | 'executing'

/**
 * LLM Response structure
 */
export interface LLMResponse {
  thought: string
  blackboard?: {
    UltimateGoal?: string
    CurrentTask?: string
    executionStrategy?: string
  }
  actions: ActionInstruction[]
}

/**
 * Conscious machine context
 */
export interface ConsciousMachineContext {
  /** Event queue */
  eventQueue: BotEvent[]

  /** Blackboard state */
  blackboard: BlackboardState

  /** Pending actions (with IDs assigned) */
  pendingActions: Map<string, ActionInstruction>

  /** In-flight actions (currently executing) */
  inFlightActions: Set<string>

  /** Retry count for LLM errors */
  retryCount: number

  /** Current event being processed */
  currentEvent: BotEvent | null

  /** Last LLM response */
  lastResponse: LLMResponse | null

  /** Next action ID */
  nextActionId: number
}

/**
 * Events that can be sent to the conscious machine
 */
export type ConsciousEvent
  = | { type: 'ENQUEUE_EVENT', event: BotEvent }
    | { type: 'CONTEXT_READY', context: string }
    | { type: 'LLM_RESPONSE', response: LLMResponse }
    | { type: 'LLM_ERROR', error: Error }
    | { type: 'ACTION_STARTED', actionId: string }
    | { type: 'ACTION_COMPLETED', actionId: string, result?: unknown }
    | { type: 'ACTION_FAILED', actionId: string, error: unknown }
    | { type: 'ALL_ACTIONS_DONE' }
    | { type: 'RETRY' }
    | { type: 'ABORT' }

/**
 * Input for creating the conscious machine
 */
export interface ConsciousMachineInput {
  /** Initial blackboard state */
  initialBlackboard?: BlackboardState

  /** Callback to build context from event */
  buildContext: (event: BotEvent, blackboard: BlackboardState) => Promise<string>

  /** Callback to call LLM */
  callLLM: (systemPrompt: string, userMessage: string) => Promise<LLMResponse>

  /** Callback to execute action */
  executeAction: (action: ActionInstruction) => Promise<void>

  /** Callback when state changes */
  onStateChange?: (state: ConsciousState) => void

  /** Maximum retry attempts */
  maxRetries?: number
}
