import type { Logg } from '@guiiai/logg'

import type { TaskExecutor } from '../action/task-executor'
import type { EventBus, TracedEvent } from '../os'
import type { PerceptionAPI } from '../perception/perception-api'
import type { PerceptionSignal } from '../perception/types/signals'
import type { MineflayerWithAgents } from '../types'
import type { ReflexContextState } from './context'
import type { BehaviorDefinition, ReflexActor, ReflexContextSnapshot, ReflexMode } from './machines'
import type { ReflexModeId } from './modes'

import { DebugService } from '../../debug'
import { greetingBehavior } from './behaviors/greeting'
import { lookAtBehavior } from './behaviors/look-at'
import { teabagBehavior } from './behaviors/teabag'
import { ReflexContext } from './context'
import { createReflexActor } from './machines'

/**
 * Adapter to convert existing ReflexBehavior to machine BehaviorDefinition
 */
function adaptBehavior(behavior: any, context: ReflexContext): BehaviorDefinition {
  return {
    id: behavior.id,
    modes: behavior.modes as ReflexMode[],
    cooldownMs: behavior.cooldownMs,
    when: (ctx: ReflexContextSnapshot) => {
      // Update context from snapshot for behavior compatibility
      return behavior.when(ctx, { context })
    },
    score: (ctx: ReflexContextSnapshot) => {
      return behavior.score(ctx, { context })
    },
    run: (api: any) => {
      return behavior.run(api)
    },
  }
}

export class ReflexManager {
  private bot: MineflayerWithAgents | null = null
  private reflexActor: ReflexActor | null = null
  private readonly context = new ReflexContext()
  private unsubscribe: (() => void) | null = null
  private unsubscribeTaskExecutor: (() => void) | null = null

  constructor(
    private readonly deps: {
      eventBus: EventBus
      perception: PerceptionAPI
      taskExecutor: TaskExecutor
      logger: Logg
    },
  ) { }

  public init(bot: MineflayerWithAgents): void {
    this.bot = bot

    // Create and start the reflex machine actor
    this.reflexActor = createReflexActor({
      behaviors: [
        adaptBehavior(greetingBehavior, this.context),
        adaptBehavior(lookAtBehavior, this.context),
        adaptBehavior(teabagBehavior, this.context),
      ],
      onModeChange: (mode) => {
        this.emitReflexState()
        this.onModeEnter(mode, bot)
      },
      onBehaviorEnd: () => this.emitReflexState(),
    })

    this.reflexActor.start()

    // Subscribe to all signals from RuleEngine
    this.unsubscribe = this.deps.eventBus.subscribe('signal:*', (event) => {
      this.onSignal(event as TracedEvent<PerceptionSignal>)
    })

    // Wire task executor events to state machine
    const onStarted = () => {
      this.reflexActor?.send({ type: 'TASK_STARTED' })
    }

    const onCompleted = () => {
      this.reflexActor?.send({ type: 'TASK_COMPLETED' })
    }

    const onFailed = () => {
      this.reflexActor?.send({ type: 'TASK_FAILED' })
    }

    this.deps.taskExecutor.on('action:started', onStarted)
    this.deps.taskExecutor.on('action:completed', onCompleted)
    this.deps.taskExecutor.on('action:failed', onFailed)

    this.unsubscribeTaskExecutor = () => {
      ; (this.deps.taskExecutor as any).off?.('action:started', onStarted)
      ; (this.deps.taskExecutor as any).off?.('action:completed', onCompleted)
      ; (this.deps.taskExecutor as any).off?.('action:failed', onFailed)
      ; (this.deps.taskExecutor as any).removeListener?.('action:started', onStarted)
      ; (this.deps.taskExecutor as any).removeListener?.('action:completed', onCompleted)
      ; (this.deps.taskExecutor as any).removeListener?.('action:failed', onFailed)
    }
  }

  public destroy(): void {
    if (this.reflexActor) {
      this.reflexActor.send({ type: 'MODE_OVERRIDE', mode: 'idle' })
      this.reflexActor.stop()
      this.reflexActor = null
    }

    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    if (this.unsubscribeTaskExecutor) {
      this.unsubscribeTaskExecutor()
      this.unsubscribeTaskExecutor = null
    }
    this.bot = null
  }

  public getContextSnapshot(): ReflexContextState {
    return this.context.getSnapshot()
  }

  public getMode(): ReflexModeId {
    if (!this.reflexActor)
      return 'idle'

    const snapshot = this.reflexActor.getSnapshot()
    const stateValue = snapshot.value
    return (typeof stateValue === 'string' ? stateValue : 'idle') as ReflexModeId
  }

  public updateEnvironment(patch: Partial<ReflexContextState['environment']>): void {
    this.context.updateEnvironment(patch)
    this.reflexActor?.send({ type: 'UPDATE_ENVIRONMENT', patch })
  }

  private onModeEnter(mode: ReflexMode, bot: MineflayerWithAgents): void {
    // Handle social mode entry - start following player
    if (mode === 'social') {
      const snap = this.context.getSnapshot()
      const preferred = snap.social.lastSpeaker

      // Find nearby player to follow
      const players = Object.keys(bot.bot.players ?? {})
        .filter(p => p !== bot.bot.username)

      const target = preferred && players.includes(preferred) ? preferred : players[0]
      if (target) {
        import('../../skills/movement').then(({ followPlayer }) => {
          followPlayer(bot, target)
        })
      }
    }
  }

  private onSignal(event: TracedEvent<PerceptionSignal>): void {
    const bot = this.bot
    if (!bot || !this.reflexActor)
      return

    const signal = event.payload
    const now = Date.now()

    // Update local context for behavior compatibility
    this.context.updateNow(now)
    this.context.updateAttention({
      lastSignalType: signal.type,
      lastSignalSourceId: signal.sourceId ?? null,
      lastSignalAt: now,
    })

    if (signal.type === 'social_gesture') {
      this.context.updateSocial({
        lastGesture: (signal.metadata as any)?.gesture ?? 'unknown',
        lastGestureAt: now,
      })
    }

    if (signal.type === 'chat_message') {
      const username = typeof (signal.metadata as any)?.username === 'string'
        ? String((signal.metadata as any).username)
        : (signal.sourceId ?? null)

      const message = typeof (signal.metadata as any)?.message === 'string'
        ? String((signal.metadata as any).message)
        : null

      this.context.updateSocial({
        lastSpeaker: username,
        lastMessage: message,
        lastMessageAt: now,
      })
    }

    // Send signal to state machine
    this.reflexActor.send({ type: 'SIGNAL', payload: signal })

    // Tick to trigger behavior selection
    this.reflexActor.send({
      type: 'TICK',
      deltaMs: 0,
      bot,
      perception: this.deps.perception,
    })

    this.emitReflexState()
  }

  private emitReflexState(): void {
    if (!this.reflexActor)
      return

    const snapshot = this.reflexActor.getSnapshot()
    const mode = typeof snapshot.value === 'string' ? snapshot.value : 'idle'

    DebugService.getInstance().emitReflexState({
      mode: mode as ReflexModeId,
      activeBehaviorId: snapshot.context.activeBehaviorId,
      context: this.context.getSnapshot(),
    })
  }
}
