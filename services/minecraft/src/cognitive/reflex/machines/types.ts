import type { Vec3 } from 'vec3'

import type { PerceptionAPI } from '../../perception/perception-api'
import type { MineflayerWithAgents } from '../../types'
import type { ReflexContext } from '../context'

/**
 * Reflex mode states
 */
export type ReflexMode = 'idle' | 'social' | 'alert' | 'work' | 'wander'

/**
 * Behavior definition (from existing ReflexBehavior)
 */
export interface BehaviorDefinition {
  id: string
  modes: ReflexMode[]
  cooldownMs?: number
  when: (ctx: ReflexContextSnapshot) => boolean
  score: (ctx: ReflexContextSnapshot) => number
  run: (api: BehaviorAPI) => void | Promise<void>
}

/**
 * Snapshot of reflex context state
 */
export interface ReflexContextSnapshot {
  now: number
  self: {
    location: Vec3
    holding: string | null
    health: number
    food: number
  }
  environment: {
    time: string
    weather: 'clear' | 'rain' | 'thunder'
    nearbyPlayers: Array<{ name: string, distance?: number }>
    nearbyPlayersGaze: Array<{
      name: string
      distanceToSelf: number
      lookPoint: { x: number, y: number, z: number }
      hitBlock: null | { name: string, pos: { x: number, y: number, z: number } }
    }>
    nearbyEntities: Array<{ name: string, distance?: number, kind?: string }>
    lightLevel: number
  }
  social: {
    lastSpeaker: string | null
    lastMessage: string | null
    lastMessageAt: number | null
    lastGreetingAtBySpeaker: Record<string, number>
    lastGesture: string | null
    lastGestureAt: number | null
  }
  threat: {
    threatScore: number
    lastThreatAt: number | null
    lastThreatSource: string | null
  }
  attention: {
    lastSignalType: string | null
    lastSignalSourceId: string | null
    lastSignalAt: number | null
  }
}

/**
 * API provided to behaviors during execution
 */
export interface BehaviorAPI {
  bot: MineflayerWithAgents
  context: ReflexContext
  perception: PerceptionAPI
}

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
    | { type: 'TICK', deltaMs: number, bot: MineflayerWithAgents, perception: PerceptionAPI }
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
