import type { PerceptionAPI } from '../../perception/perception-api'
import type { MineflayerWithAgents } from '../../types'
import type { ReflexContextState } from '../context'
import type { ReflexBehavior } from '../types/behavior'

/**
 * Reflex mode states
 */
export type ReflexMode = 'idle' | 'social' | 'alert' | 'work' | 'wander'

/**
 * Behavior definition (from existing ReflexBehavior)
 */
export type BehaviorDefinition = ReflexBehavior

/**
 * Snapshot of reflex context state
 */
export type ReflexContextSnapshot = ReflexContextState

/**
 * Reflex machine context
 */
export interface ReflexMachineContext {
  /** Reflex context state */
  contextState: ReflexContextSnapshot

  /** Registered behaviors */
  behaviors: BehaviorDefinition[]

  /** Run history for cooldown tracking */
  runHistory: Map<string, { lastRunAt: number }>

  /** Currently active behavior */
  activeBehaviorId: string | null

  /** When current behavior should complete */
  activeBehaviorUntil: number | null

  /** Locked follow target for social mode */
  lockedFollowTargetName: string | null

  /** In-flight action count from TaskExecutor */
  inFlightActionsCount: number
}

/**
 * Events that can be sent to the reflex machine
 */
export type ReflexEvent
  = | { type: 'INIT', bot: MineflayerWithAgents }
    | { type: 'SIGNAL', payload: any }
    | { type: 'TICK', deltaMs: number, bot: MineflayerWithAgents | null, perception: PerceptionAPI }
    | { type: 'TASK_STARTED' }
    | { type: 'TASK_COMPLETED' }
    | { type: 'TASK_FAILED' }
    | { type: 'MODE_OVERRIDE', mode: ReflexMode }
    | { type: 'BEHAVIOR_DONE' }
    | { type: 'UPDATE_CONTEXT', patch: Partial<ReflexContextSnapshot> }
    | { type: 'UPDATE_ENVIRONMENT', patch: Partial<ReflexContextSnapshot['environment']> }

/**
 * Input for creating the reflex machine
 */
export interface ReflexMachineInput {
  behaviors: BehaviorDefinition[]
  onBehaviorEnd?: () => void
  onModeChange?: (mode: ReflexMode) => void
}
