import type { Logg } from '@guiiai/logg'
import type { Neuri } from 'neuri'

import type { TaskExecutor } from '../action/task-executor'
import type { ActionInstruction } from '../action/types'
import type { EventBus, TracedEvent } from '../os'
import type { PerceptionSignal } from '../perception/types/signals'
import type { ReflexManager } from '../reflex/reflex-manager'
import type { BotEvent, MineflayerWithAgents } from '../types'
import type { ConsciousActor, LLMResponse } from './machines'

import { system, user } from 'neuri/openai'

import { config } from '../../composables/config'
import { DebugService } from '../../debug'
import { Blackboard } from './blackboard'
import { buildConsciousContextView } from './context-view'
import { createConsciousActor } from './machines'
import { generateBrainSystemPrompt } from './prompts/brain-prompt'

function toErrorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.message
  if (typeof err === 'string')
    return err
  try {
    return JSON.stringify(err)
  }
  catch {
    return String(err)
  }
}

function getErrorStatus(err: unknown): number | undefined {
  const anyErr = err as any
  const status = anyErr?.status ?? anyErr?.response?.status ?? anyErr?.cause?.status
  return typeof status === 'number' ? status : undefined
}

function getErrorCode(err: unknown): string | undefined {
  const anyErr = err as any
  const code = anyErr?.code ?? anyErr?.cause?.code
  return typeof code === 'string' ? code : undefined
}

function isLikelyAuthOrBadArgError(err: unknown): boolean {
  const msg = toErrorMessage(err).toLowerCase()
  const status = getErrorStatus(err)
  if (status === 401 || status === 403)
    return true

  return (
    msg.includes('unauthorized')
    || msg.includes('invalid api key')
    || msg.includes('authentication')
    || msg.includes('forbidden')
    || msg.includes('badarg')
    || msg.includes('bad arg')
    || msg.includes('invalid argument')
    || msg.includes('invalid_request_error')
  )
}

function isLikelyRecoverableError(err: unknown): boolean {
  const status = getErrorStatus(err)
  if (status === 429)
    return true
  if (typeof status === 'number' && status >= 500)
    return true

  const code = getErrorCode(err)
  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code))
    return true

  const msg = toErrorMessage(err).toLowerCase()
  return (
    msg.includes('timeout')
    || msg.includes('timed out')
    || msg.includes('rate limit')
    || msg.includes('overloaded')
    || msg.includes('temporarily')
    || msg.includes('try again')
  )
}

interface BrainDeps {
  eventBus: EventBus
  neuri: Neuri
  logger: Logg
  taskExecutor: TaskExecutor
  reflexManager: ReflexManager
}

export class Brain {
  private blackboard: Blackboard
  private debugService: DebugService
  private consciousActor: ConsciousActor | null = null

  private bot: MineflayerWithAgents | undefined

  private nextActionId = 1
  private inFlightActions = new Map<string, ActionInstruction>()

  private feedbackDebounceMs = Number.parseInt(process.env.BRAIN_FEEDBACK_DEBOUNCE_MS ?? '200')
  private feedbackDebounceTimer: NodeJS.Timeout | undefined

  private feedbackBarrierTimeoutMs = Number.parseInt(process.env.BRAIN_FEEDBACK_BARRIER_TIMEOUT_MS ?? '1000')
  private waitingForFeedbackIds = new Set<string>()
  private feedbackBarrierTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: BrainDeps) {
    this.blackboard = new Blackboard()
    this.debugService = DebugService.getInstance()
  }

  private async handlePerceptionSignal(bot: MineflayerWithAgents, signal: PerceptionSignal): Promise<void> {
    this.log('INFO', `Brain: Received perception: ${signal.description}`)

    if (signal.type === 'chat_message') {
      const parts = signal.description.split(': ')
      const sender = parts.length > 1 ? parts[0] : 'Unknown'
      const content = parts.length > 1 ? parts.slice(1).join(': ') : signal.description

      this.blackboard.addChatMessage({
        sender,
        content,
        timestamp: Date.now(),
      })
    }

    await this.enqueueEvent(bot, {
      type: 'perception',
      payload: signal,
      source: {
        type: 'minecraft',
        id: signal.sourceId ?? 'perception',
      },
      timestamp: Date.now(),
    })
  }

  public init(bot: MineflayerWithAgents): void {
    this.log('INFO', 'Brain: Initializing...')
    this.bot = bot
    this.blackboard.update({ selfUsername: bot.username })

    // Create conscious state machine actor
    this.consciousActor = createConsciousActor({
      initialBlackboard: undefined, // Will use default from machine
      buildContext: async (event, _blackboard) => {
        this.updatePerception(bot)
        return this.contextFromEvent(event)
      },
      callLLM: async (_systemPrompt, userMessage) => {
        // Use existing decision logic
        const fullSystemPrompt = generateBrainSystemPrompt(this.blackboard, this.deps.taskExecutor.getAvailableActions())
        const decision = await this.decide(fullSystemPrompt, userMessage)
        if (!decision) {
          throw new Error('No decision made')
        }
        return decision
      },
      executeAction: async (action) => {
        this.deps.taskExecutor.executeActions([action])
      },
      onStateChange: (state) => {
        this.updateDebugState()
        this.debugService.emit('conscious:state', { state })
      },
    })

    this.consciousActor.start()

    // Subscribe to actor state changes
    this.consciousActor.subscribe((_snapshot) => {
      this.updateDebugState()
    })

    const handleSignal = async (signal: PerceptionSignal) => {
      if (signal.type !== 'chat_message' && signal.type !== 'social_presence')
        return

      try {
        await this.handlePerceptionSignal(bot, signal)
      }
      catch (err) {
        this.log('ERROR', 'Brain: Failed to enqueue chat event', { error: err })
      }
    }

    // Perception Signal Handler - unified on EventBus
    this.deps.eventBus.subscribe<PerceptionSignal>('signal:chat_message', (event: TracedEvent<PerceptionSignal>) => {
      void handleSignal(event.payload)
    })

    this.deps.eventBus.subscribe<PerceptionSignal>('signal:social_presence', (event: TracedEvent<PerceptionSignal>) => {
      void handleSignal(event.payload)
    })

    // Listen to Task Execution Events (Action Feedback)
    this.deps.taskExecutor.on('action:started', ({ action }) => {
      const id = action.id
      if (id)
        this.inFlightActions.set(id, action)
      this.updatePendingActionsOnBlackboard()

      // Notify state machine
      this.consciousActor?.send({ type: 'ACTION_STARTED', actionId: id ?? 'unknown' })
    })

    this.deps.taskExecutor.on('action:completed', async ({ action, result }) => {
      this.log('INFO', `Brain: Action completed: ${action.type}`)

      const id = action.id
      if (id)
        this.inFlightActions.delete(id)
      if (id)
        this.waitingForFeedbackIds.delete(id)
      this.updatePendingActionsOnBlackboard()
      this.blackboard.addActionHistoryLine(this.formatActionHistoryLine(action, 'success', result))

      // Notify state machine
      this.consciousActor?.send({ type: 'ACTION_COMPLETED', actionId: id ?? 'unknown', result })

      if (this.waitingForFeedbackIds.size === 0 && this.feedbackBarrierTimer) {
        clearTimeout(this.feedbackBarrierTimer)
        this.feedbackBarrierTimer = undefined
      }

      if (!action.require_feedback)
        return

      await this.enqueueEvent(bot, {
        type: 'feedback',
        payload: {
          status: 'success',
          action,
          result,
        },
        source: { type: 'system', id: 'executor' },
        timestamp: Date.now(),
      })
    })

    this.deps.taskExecutor.on('action:failed', async ({ action, error }) => {
      this.log('WARN', `Brain: Action failed: ${action.type}`, { error })

      const id = action.id
      if (id)
        this.inFlightActions.delete(id)
      if (id)
        this.waitingForFeedbackIds.delete(id)
      this.updatePendingActionsOnBlackboard()
      this.blackboard.addActionHistoryLine(this.formatActionHistoryLine(action, 'failure', undefined, error))

      // Notify state machine
      this.consciousActor?.send({ type: 'ACTION_FAILED', actionId: id ?? 'unknown', error })

      if (this.waitingForFeedbackIds.size === 0 && this.feedbackBarrierTimer) {
        clearTimeout(this.feedbackBarrierTimer)
        this.feedbackBarrierTimer = undefined
      }

      await this.enqueueEvent(bot, {
        type: 'feedback',
        payload: {
          status: 'failure',
          action,
          error: error.message || error,
        },
        source: { type: 'system', id: 'executor' },
        timestamp: Date.now(),
      })
    })

    this.log('INFO', 'Brain: Online.')
    this.updateDebugState()
  }

  public destroy(): void {
    if (this.consciousActor) {
      this.consciousActor.stop()
      this.consciousActor = null
    }
  }

  // --- Event Queue Logic (now via State Machine) ---

  private async enqueueEvent(bot: MineflayerWithAgents, event: BotEvent): Promise<void> {
    this.log('DEBUG', `Brain: Enqueueing event type=${event.type}`)

    if (!this.consciousActor) {
      this.log('WARN', 'Brain: No conscious actor, skipping event')
      return
    }

    // Handle feedback debouncing
    if (event.type === 'feedback' && this.feedbackDebounceMs > 0) {
      if (this.feedbackDebounceTimer)
        clearTimeout(this.feedbackDebounceTimer)
      this.feedbackDebounceTimer = setTimeout(() => {
        this.feedbackDebounceTimer = undefined
        this.consciousActor?.send({ type: 'ENQUEUE_EVENT', event })
      }, this.feedbackDebounceMs)
      return
    }

    // Send event to state machine
    this.consciousActor.send({ type: 'ENQUEUE_EVENT', event })
    this.updateDebugState()

    // Process LLM decision if event triggers it
    await this.processEventWithMachine(bot, event)
  }

  private async processEventWithMachine(bot: MineflayerWithAgents, event: BotEvent): Promise<void> {
    if (!this.consciousActor)
      return

    const snapshot = this.consciousActor.getSnapshot()

    // If there are queued events, the machine should process them
    // We manually trigger processing since the machine's automatic transitions
    // might not work perfectly for async operations
    if (snapshot.context.eventQueue.length > 0 && snapshot.value === 'idle') {
      // Process the event through OODA loop
      await this.processEvent(bot, event)
    }
  }

  // --- Cognitive Cycle ---

  private contextFromEvent(event: BotEvent): string {
    switch (event.type) {
      case 'perception': {
        const signal = event.payload as PerceptionSignal
        const sourceInfo = signal.sourceId ? ` (source: ${signal.sourceId})` : ''
        return `Perception [${signal.type}]${sourceInfo}: ${signal.description}`
      }
      case 'feedback': {
        const payload = event.payload as any
        if (payload?.status === 'batch' && Array.isArray(payload.feedbacks)) {
          return `Internal Feedback (batched): ${JSON.stringify(payload.feedbacks)}`
        }

        const { status, action, result, error } = payload
        const actionCtx = action
          ? {
              id: action.id,
              type: action.type,
              ...(action.type === 'sequential' || action.type === 'parallel'
                ? { tool: action.step.tool, params: action.step.params }
                : { message: action.message }),
            }
          : undefined
        return `Internal Feedback: ${status}. Last Action: ${JSON.stringify(actionCtx)}. Result: ${JSON.stringify(result || error)}`
      }
      default:
        return ''
    }
  }

  private ensureActionIds(actions: ActionInstruction[]): ActionInstruction[] {
    return actions.map((action) => {
      if (action.id)
        return action
      return {
        ...action,
        id: `a${this.nextActionId++}`,
      }
    })
  }

  private updatePendingActionsOnBlackboard(): void {
    const pending = [...this.inFlightActions.values()].map(a => this.formatPendingActionLine(a))
    if (this.waitingForFeedbackIds.size > 0)
      pending.unshift(`[barrier] waiting for ${this.waitingForFeedbackIds.size} required feedback(s)`)
    this.blackboard.setPendingActions(pending)
  }

  private formatPendingActionLine(action: ActionInstruction): string {
    if (action.type === 'chat')
      return `${action.id ?? '?'} chat: ${action.message}`
    return `${action.id ?? '?'} ${action.type}: ${action.step.tool} ${JSON.stringify(action.step.params ?? {})}`
  }

  private formatActionHistoryLine(
    action: ActionInstruction,
    status: 'success' | 'failure',
    result?: unknown,
    error?: unknown,
  ): string {
    const base = this.formatPendingActionLine(action)
    const suffix = status === 'success'
      ? `=> ok ${result ? JSON.stringify(result) : ''}`
      : `=> failed ${error instanceof Error ? error.message : JSON.stringify(error)}`
    return `${base} ${suffix}`
  }

  private async processEvent(bot: MineflayerWithAgents, event: BotEvent): Promise<void> {
    // OODA Loop: Observe -> Orient -> Decide -> Act

    // 1. Observe (Update Blackboard with Environment Sense)
    this.updatePerception(bot)

    // 2. Orient (Contextualize Event)
    // Environmental context are included in the system prompt blackboard
    const additionalCtx = this.contextFromEvent(event)

    // 3. Decide (LLM Call)
    const systemPrompt = generateBrainSystemPrompt(this.blackboard, this.deps.taskExecutor.getAvailableActions())
    const decision = await this.decide(systemPrompt, additionalCtx)

    if (!decision) {
      this.log('WARN', 'Brain: No decision made.')
      return
    }

    // 4. Act (Execute Decision)
    this.log('INFO', `Brain: Thought: ${decision.thought}`)

    // Update Blackboard
    this.blackboard.update({
      ultimateGoal: decision.blackboard?.UltimateGoal || this.blackboard.ultimate_goal,
      currentTask: decision.blackboard?.CurrentTask || this.blackboard.current_task,
      strategy: decision.blackboard?.executionStrategy || this.blackboard.strategy,
    })

    // Sync Blackboard to Debug
    this.debugService.updateBlackboard(this.blackboard)

    // Issue Actions
    if (decision.actions && decision.actions.length > 0) {
      const actionsWithIds = this.ensureActionIds(decision.actions)

      // Start feedback barrier for this turn if any actions require feedback.
      const required = actionsWithIds.filter(a => a.require_feedback && a.id).map(a => a.id as string)
      if (required.length > 0) {
        required.forEach(id => this.waitingForFeedbackIds.add(id))

        if (this.feedbackBarrierTimer)
          clearTimeout(this.feedbackBarrierTimer)
        this.feedbackBarrierTimer = setTimeout(() => {
          this.feedbackBarrierTimer = undefined
          this.waitingForFeedbackIds.clear()
          this.updatePendingActionsOnBlackboard()
        }, this.feedbackBarrierTimeoutMs)

        this.updatePendingActionsOnBlackboard()
      }

      // Record own chat actions to memory
      for (const action of actionsWithIds) {
        if (action.type === 'chat') {
          this.blackboard.addChatMessage({
            sender: config.bot.username || '[Me]',
            content: action.message,
            timestamp: Date.now(),
          })
        }
      }

      this.deps.taskExecutor.executeActions(actionsWithIds)
    }
  }

  private updatePerception(_bot: MineflayerWithAgents): void {
    const ctx = this.deps.reflexManager.getContextSnapshot()
    const view = buildConsciousContextView(ctx)
    this.blackboard.updateContextView(view)

    // Sync Blackboard to Debug
    this.debugService.updateBlackboard(this.blackboard)
  }

  private async decide(sysPrompt: string, userMsg: string): Promise<LLMResponse | null> {
    const maxAttempts = 3

    const decideOnce = async (): Promise<LLMResponse | null> => {
      const request_start = Date.now()
      const response = await this.deps.neuri.handleStateless(
        [
          system(sysPrompt),
          user(userMsg),
        ],
        async (ctx) => {
          const completion = await ctx.reroute('action', ctx.messages, {
            model: config.openai.model,
            response_format: { type: 'json_object' },
          } as any) as any

          // Trace LLM
          this.debugService.traceLLM({
            route: 'action',
            messages: ctx.messages,
            content: completion?.choices?.[0]?.message?.content,
            usage: completion?.usage,
            model: config.openai.model,
            duration: Date.now() - request_start,
          })

          if (!completion || !completion.choices?.[0]?.message?.content) {
            throw new Error('LLM failed to return content')
          }
          return completion.choices[0].message.content
        },
      )

      if (!response)
        return null

      // TODO: use toolcall instead of outputing json directly
      return JSON.parse(response) as LLMResponse
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await decideOnce()
      }
      catch (err) {
        const remaining = maxAttempts - attempt
        const shouldRetry = remaining > 0 && !isLikelyAuthOrBadArgError(err) && isLikelyRecoverableError(err)
        this.log('ERROR', 'Brain: Decision attempt failed', {
          error: err,
          attempt,
          remaining,
          shouldRetry,
          status: getErrorStatus(err),
          code: getErrorCode(err),
        })

        if (shouldRetry)
          continue

        const errMsg = toErrorMessage(err)
        try {
          this.bot?.bot?.chat?.(`[Brain] decide failed: ${errMsg}`)
        }
        catch (chatErr) {
          this.log('ERROR', 'Brain: Failed to send error message to chat', { error: chatErr })
        }
        throw err
      }
    }

    return null
  }

  // --- Debug Helpers ---

  private log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, fields?: any) {
    // Dual logging: Console/File via Logger AND DebugServer
    if (level === 'ERROR')
      this.deps.logger.withError(fields?.error).error(message)
    else if (level === 'WARN')
      this.deps.logger.warn(message, fields)
    else this.deps.logger.log(message, fields)

    this.debugService.log(level, message, fields)
  }

  private updateDebugState(processingEvent?: BotEvent) {
    // Get state from machine if available
    if (this.consciousActor) {
      const snapshot = this.consciousActor.getSnapshot()
      this.debugService.updateQueue(
        snapshot.context.eventQueue,
        processingEvent ?? snapshot.context.currentEvent ?? undefined,
      )
      this.debugService.emit('conscious:state', {
        state: snapshot.value,
        eventQueueLength: snapshot.context.eventQueue.length,
        pendingActionsCount: snapshot.context.pendingActions.size,
        inFlightActionsCount: snapshot.context.inFlightActions.size,
        retryCount: snapshot.context.retryCount,
      })
    }
  }
}
