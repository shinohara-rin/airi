import type { PerceptionAPI } from '../../perception/perception-api'
import type { ReflexContext } from '../context'
import type { ReflexModeId } from '../modes'
import type { ReflexDecision } from './intents'

export interface ReflexBehavior {
  id: string
  modes: ReflexModeId[]
  cooldownMs?: number
  when: (ctx: ReturnType<ReflexContext['getSnapshot']>, perception: PerceptionAPI) => boolean
  score: (ctx: ReturnType<ReflexContext['getSnapshot']>, perception: PerceptionAPI) => number
  run: (ctx: ReturnType<ReflexContext['getSnapshot']>, perception: PerceptionAPI) => ReflexDecision | Promise<ReflexDecision> | null | Promise<null>
}

export interface BehaviorRunRecord {
  lastRunAt: number
}
