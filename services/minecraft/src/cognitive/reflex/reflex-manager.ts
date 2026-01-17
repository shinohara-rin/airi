import type { Logg } from '@guiiai/logg'

import type { TaskExecutor } from '../action/task-executor'
import type { EventBus, TracedEvent } from '../os'
import type { PerceptionAPI } from '../perception/perception-api'
import type { PerceptionSignal } from '../perception/types/signals'
import type { MineflayerWithAgents } from '../types'
import type { ReflexContextState } from './context'
import type { ReflexActor, ReflexMode } from './machines'
import type { ReflexModeId } from './modes'
import type { ReflexExecutor } from './reflex-executor'
import type { ReflexSkills } from './reflex-skills'
import type { ReflexBehavior } from './types/behavior'

import { DebugService } from '../../debug'
import { greetingBehavior } from './behaviors/greeting'
import { lookAtBehavior } from './behaviors/look-at'
import { teabagBehavior } from './behaviors/teabag'
import { ReflexContext } from './context'
import { createReflexActor } from './machines'

export class ReflexManager {
  private bot: MineflayerWithAgents | null = null
  private reflexActor: ReflexActor | null = null
  private readonly context = new ReflexContext()
  private unsubscribe: (() => void) | null = null
  private unsubscribeTaskExecutor: (() => void) | null = null
  private tickCount = 0
  private lastRunAt = new Map<string, number>()
  private _onTick: (() => void) | null = null

  constructor(
    private readonly deps: {
      eventBus: EventBus
      perception: PerceptionAPI
      taskExecutor: TaskExecutor
      logger: Logg
      executor: ReflexExecutor
      skills: ReflexSkills
    },
  ) { }

  public init(bot: MineflayerWithAgents): void {
    this.bot = bot

    // Create and start the reflex machine actor (Core State Machine)
    // We pass behaviors just for metadata if the machine wants them, but we execute them here.
    this.reflexActor = createReflexActor({
      behaviors: [
        greetingBehavior,
        lookAtBehavior,
        teabagBehavior,
      ],
      onModeChange: (mode) => {
        this.emitReflexState()
        this.onModeEnter(mode, bot)
      },
      onBehaviorEnd: () => this.emitReflexState(),
    })

    this.reflexActor.start()

    // Subscribe to signals
    this.unsubscribe = this.deps.eventBus.subscribe('signal:*', (event) => {
      this.onSignal(event as TracedEvent<PerceptionSignal>)
    })

    // Wire task executor events
    const onStarted = () => this.reflexActor?.send({ type: 'TASK_STARTED' })
    const onCompleted = () => this.reflexActor?.send({ type: 'TASK_COMPLETED' })
    const onFailed = () => this.reflexActor?.send({ type: 'TASK_FAILED' })

    this.deps.taskExecutor.on('action:started', onStarted)
    this.deps.taskExecutor.on('action:completed', onCompleted)
    this.deps.taskExecutor.on('action:failed', onFailed)

    this.unsubscribeTaskExecutor = () => {
      this.deps.taskExecutor.off('action:started', onStarted)
      this.deps.taskExecutor.off('action:completed', onCompleted)
      this.deps.taskExecutor.off('action:failed', onFailed)
    }

    // Tick Loop
    const onTick = () => this.onTick()
    bot.bot.on('physicTick', onTick)
    this._onTick = onTick
  }

  public destroy(): void {
    if (this.bot && this._onTick) {
      this.bot.bot.off('physicTick', this._onTick)
    }

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

  private onTick() {
    this.tickCount++
    if (this.tickCount % 5 !== 0)
      return // 250ms (assuming 20tps, 5 ticks = 0.25s)

    if (!this.bot || !this.reflexActor)
      return

    const now = Date.now()
    this.context.updateNow(now)

    // 1. Determine Mode
    const mode = this.getMode()

    // 2. Select Behavior
    const behaviors: ReflexBehavior[] = [greetingBehavior, lookAtBehavior, teabagBehavior]
    const candidates = behaviors.filter(b => b.modes.includes(mode))

    const snapshot = this.context.getSnapshot()
    let bestBehavior: ReflexBehavior | null = null
    let bestScore = -1

    for (const b of candidates) {
      // Check cooldown
      if (b.cooldownMs) {
        const lastRun = this.lastRunAt.get(b.id)
        if (lastRun && now - lastRun < b.cooldownMs)
          continue
      }

      if (b.when(snapshot, this.deps.perception)) {
        const score = b.score(snapshot, this.deps.perception)
        if (score > bestScore) {
          bestScore = score
          bestBehavior = b
        }
      }
    }

    // 3. Run Behavior
    if (bestBehavior) {
      void (async () => {
        if (!bestBehavior)
          return
        try {
          const decision = await bestBehavior.run(snapshot, this.deps.perception)

          // Update last run time
          this.lastRunAt.set(bestBehavior.id, Date.now())

          if (decision) {
            // Apply State Updates
            if (decision.stateUpdates) {
              if (decision.stateUpdates.social)
                this.context.updateSocial(decision.stateUpdates.social)
              if (decision.stateUpdates.attention)
                this.context.updateAttention(decision.stateUpdates.attention)
              if (decision.stateUpdates.threat)
                this.context.updateThreat(decision.stateUpdates.threat)
              if (decision.stateUpdates.environment)
                this.context.updateEnvironment(decision.stateUpdates.environment)
              if (decision.stateUpdates.self)
                this.context.updateSelf(decision.stateUpdates.self)
            }

            // Execute Intent
            if (decision.intent && this.bot) {
              await this.deps.executor.execute(decision.intent, this.bot)
            }

            this.emitReflexState()
          }
        }
        catch (err) {
          this.deps.logger.withError(err).warn(`Reflex behavior ${bestBehavior.id} failed`)
        }
      })()
    }
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
        void this.deps.skills.followPlayer(bot, target)
      }
    }
  }

  private onSignal(event: TracedEvent<PerceptionSignal>): void {
    if (!this.bot || !this.reflexActor)
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

    // We don't need to send TICK to machine anymore for behavior selection
    // But maybe for state transitions inside the machine (if it relies on TICK).
    // The machine I read earlier has `on: { TICK: ... }` in social state to exit.
    // So I SHOULD send tick to machine as well.

    this.reflexActor.send({
      type: 'TICK',
      deltaMs: 0,
      bot: this.bot, // Machine might need bot reference for some guards/actions?
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
