import type { Vec3 } from 'vec3'
import type {
  ReflexAttentionState,
  ReflexEnvironmentState,
  ReflexSelfState,
  ReflexSocialState,
  ReflexThreatState,
} from '../context'

export type ReflexIntent =
  | { type: 'chat', message: string }
  | { type: 'look_at', target: Vec3 }
  | { type: 'teabag' }

export interface ReflexStateUpdates {
  social?: Partial<ReflexSocialState>
  attention?: Partial<ReflexAttentionState>
  threat?: Partial<ReflexThreatState>
  environment?: Partial<ReflexEnvironmentState>
  self?: Partial<ReflexSelfState>
}

export interface ReflexDecision {
  intent?: ReflexIntent
  stateUpdates?: ReflexStateUpdates
}
