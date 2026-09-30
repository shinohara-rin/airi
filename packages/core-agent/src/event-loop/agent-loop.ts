import type { GenerationProvider } from '@proj-airi/provider-inference'
import type { Tool } from '@xsai/shared-chat'

import type { AgentLLMPort } from '../contracts/llm-port'
import type { AssistantTurn, Conversation, InputSegment, Turn } from '../messages/types'
import type { LlmUsage, StreamEvent, StreamOptions } from '../types/llm'
import type { AgentEvent, AgentEventInput, PushOptions, TriggerMode, WakeBusOptions } from './types'

import { Heartbeat } from './heartbeat'
import { WakeBus } from './wake-bus'

/** Everything the loop needs from the application for one model request. It is read at the start of every turn. */
export interface AgentRequest {
  model: string
  chatProvider: GenerationProvider
  providerId: string
  systemPrompt: string
  /** A function is resolved when the request starts, so tools registered by earlier turns are included. */
  tools?: Tool[] | (() => Promise<Tool[] | undefined>)
  headers?: Record<string, string>
  temperature?: number
  topP?: number
  /** Identifies this request to the provider and to observers. @default `{ conversationId: 'agent', turnId: <first event id> }` */
  correlation?: { conversationId: string, turnId: string }
}

/** What observers see when one turn settles. */
export interface AgentTurnResult {
  /** The events this turn answered, in delivery order. */
  events: AgentEvent[]
  /** Absent when the turn was cancelled or failed. */
  assistantTurn?: AssistantTurn
  text: string
  /**
   * `preempted` events went back to the queue and will be answered by a later turn. `cancelled` events are
   * discarded: the application interrupted the turn or the loop stopped.
   */
  outcome: 'completed' | 'preempted' | 'cancelled' | 'failed'
  error?: unknown
  usage?: LlmUsage
  /** The user turn the loop built, absent when `buildConversation` supplied the conversation. */
  userTurn?: Turn
}

export interface AgentLoopOptions {
  llm: AgentLLMPort
  resolveRequest: (batch: AgentEvent[]) => AgentRequest | Promise<AgentRequest>
  /**
   * Builds the conversation for one batch. Use it when the application owns the history, for example in
   * stored chat sessions, and has already recorded the events of the batch. The loop then keeps no history.
   * Without it, the loop keeps an in-memory history and renders each batch as one user turn.
   */
  buildConversation?: (batch: AgentEvent[], request: AgentRequest) => Conversation | Promise<Conversation>
  /** Events that must not be answered any more, for example because their session was reset. They are dropped at delivery. */
  isStale?: (event: AgentEvent) => boolean
  /** Called with the events `isStale` dropped. */
  onDiscarded?: (events: AgentEvent[]) => void
  /**
   * Chooses the events one turn answers. The rest go back to the front of the queue for the next turn.
   * Use it when events belong to different conversations that cannot share a request.
   */
  selectEvents?: (batch: AgentEvent[]) => AgentEvent[]
  /** Called for each streamed event of the running turn, in order. Text deltas here are the agent's speech. */
  onStreamEvent?: (event: StreamEvent, batch: AgentEvent[]) => void | Promise<void>
  /** Runs after the request is resolved and before the model is called. */
  onTurnStarted?: (events: AgentEvent[]) => void | Promise<void>
  onTurnSettled?: (result: AgentTurnResult) => void | Promise<void>
  /** Debounce timing. */
  bus?: Partial<WakeBusOptions>
  /**
   * Base heartbeat interval in milliseconds, read at each beat. A missing value stops beats.
   * The interval doubles for each quiet beat, up to eight times the base.
   */
  heartbeatMs?: () => number | undefined
  /** Longest tool receipt handed to the model. A longer receipt is cut and says how much was left out. @default 20000 */
  maxReceiptChars?: number
  /** Estimated tokens of history kept. The oldest whole turns are dropped past it. @default 48000 */
  maxHistoryTokens?: number
  /** Stops debounce and heartbeat wakes while a token budget for a time window is used up. */
  spendGuard?: () => { maxTokens: number, windowMs: number } | undefined
  now?: () => number
  createId?: () => string
}

const DEFAULT_BUS: WakeBusOptions = {
  quietGapMs: 1500,
  minBatchAgeMs: 500,
  maxBatchAgeMs: 6000,
  maxBatchSize: 8,
}

/** The reason of an abort that wants the events answered again, as opposed to discarded. */
class TurnPreempted extends Error {
  constructor() {
    super('Agent turn was preempted')
  }
}

function defaultCreateId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** A rough size for history trimming. Four characters are about one token. */
function estimateTokens(turns: Turn[]) {
  return Math.ceil(JSON.stringify(turns).length / 4)
}

function limitReceipt(result: unknown, maxChars: number) {
  if (typeof result !== 'string' || result.length <= maxChars)
    return result
  return `${result.slice(0, maxChars)}\n[receipt cut: ${result.length - maxChars} more characters were left out]`
}

/**
 * One agent with one conversation. Producers push events, the loop delivers them in batches, and each
 * batch runs one turn: the model can call tools over several rounds, and the streamed text is its speech.
 *
 * State model: the conversation history, the running turn, and the wake bus are runtime state. Nothing is
 * persisted here. A caller that wants persistence reads {@link AgentLoop.history}.
 *
 * Ownership: `start` runs the loop and the heartbeat. `stop` aborts a running turn and ends both. Events
 * pushed after `stop` are dropped.
 */
export class AgentLoop {
  private readonly bus: WakeBus
  private readonly heartbeat: Heartbeat
  private readonly now: () => number
  private readonly createId: () => string
  private readonly maxReceiptChars: number
  private readonly maxHistoryTokens: number
  private turns: Turn[] = []
  private running = false
  private loopDone: Promise<void> | undefined
  private active: { controller: AbortController, batch: AgentEvent[], externalized: boolean } | undefined
  private spend: { at: number, tokens: number }[] = []

  constructor(private readonly options: AgentLoopOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? defaultCreateId
    this.maxReceiptChars = options.maxReceiptChars ?? 20_000
    this.maxHistoryTokens = options.maxHistoryTokens ?? 48_000
    this.bus = new WakeBus({ ...DEFAULT_BUS, ...options.bus })
    this.bus.setPreemptHandler(() => this.cancelIfNotExternalized())
    this.heartbeat = new Heartbeat(
      () => options.heartbeatMs?.(),
      (quietSeconds) => {
        if (this.active || this.bus.pendingWaking() > 0 || this.spendGuardTripped())
          return
        this.push({
          type: 'heartbeat',
          source: 'agent-loop',
          origin: 'internal',
          text: quietSeconds < 60 ? `[system] quiet for ${quietSeconds} seconds.` : `[system] quiet for ${Math.floor(quietSeconds / 60)} minutes.`,
        }, { trigger: 'flush' })
      },
    )
  }

  /** The conversation so far, without the system prompt. It is a snapshot. */
  get history(): readonly Turn[] {
    return [...this.turns]
  }

  get busy() {
    return this.active !== undefined
  }

  /** Accepts an event. Returns the stored event, or `undefined` after `stop`. */
  push(input: AgentEventInput, options: PushOptions = {}): AgentEvent | undefined {
    if (!this.running)
      return undefined

    const event: AgentEvent = { ...input, origin: input.origin ?? 'external', id: this.createId(), ts: this.now() }
    if (event.origin === 'external')
      this.heartbeat.noteActivity()

    this.bus.push(event, { trigger: this.guardedTrigger(event, options.trigger) })
    return event
  }

  setPaused(paused: boolean) {
    this.bus.setPaused(paused)
  }

  /**
   * Cancels the running turn, whatever it has produced. Its events are discarded.
   * Pass `matches` to cancel only a turn that answers a matching event.
   */
  interrupt(matches?: (event: AgentEvent) => boolean) {
    if (!this.active)
      return
    if (matches && !this.active.batch.some(matches))
      return
    this.active.controller.abort(new Error('Agent turn was interrupted'))
  }

  start() {
    if (this.running)
      return
    this.running = true
    this.heartbeat.start()
    this.loopDone = this.run()
  }

  async stop() {
    if (!this.running)
      return
    this.running = false
    this.heartbeat.stop()
    this.active?.controller.abort(new Error('Agent loop stopped'))
    this.bus.dispose()
    // The consumer waits on a promise the disposed bus never settles, so it is not awaited here.
    this.loopDone = undefined
  }

  private guardedTrigger(event: AgentEvent, trigger: TriggerMode | undefined): TriggerMode | undefined {
    const resolved = trigger ?? (event.origin === 'internal' ? 'flush' : 'debounce')
    // A spent budget lets a debounce event wait for a waking one instead of causing a model call.
    return resolved === 'debounce' && this.spendGuardTripped() ? 'piggyback' : resolved
  }

  private spendGuardTripped() {
    const guard = this.options.spendGuard?.()
    if (!guard)
      return false

    const since = this.now() - guard.windowMs
    this.spend = this.spend.filter(entry => entry.at >= since)
    return this.spend.reduce((total, entry) => total + entry.tokens, 0) >= guard.maxTokens
  }

  /** A turn that already spoke or called a tool has visible effects, so a preempt waits for it to finish. */
  private cancelIfNotExternalized() {
    if (this.active && !this.active.externalized)
      this.active.controller.abort(new TurnPreempted())
  }

  private async run() {
    while (this.running) {
      const batch = await this.bus.nextBatch()
      if (!this.running)
        return
      await this.runTurn(batch)
    }
  }

  private toUserTurn(batch: AgentEvent[]): Turn {
    const content: InputSegment[] = batch.map(event => ({ type: 'text', text: event.text }))
    for (const event of batch) {
      for (const url of event.images ?? [])
        content.push({ type: 'image', url })
    }
    return { type: 'user', id: this.createId(), content }
  }

  private async runTurn(delivered: AgentEvent[]) {
    const stale = delivered.filter(event => this.options.isStale?.(event))
    if (stale.length > 0)
      this.options.onDiscarded?.(stale)

    const live = delivered.filter(event => !stale.includes(event))
    const batch = this.options.selectEvents?.(live) ?? live
    // The events this turn does not answer wait at the front of the queue, before newer ones.
    const rest = live.filter(event => !batch.includes(event))
    if (rest.length > 0)
      this.bus.requeue(rest)
    if (batch.length === 0)
      return

    const controller = new AbortController()
    const active = { controller, batch, externalized: false }
    this.active = active

    let text = ''
    let usage: LlmUsage | undefined
    let assistantTurn: AssistantTurn | undefined

    try {
      const request = await this.options.resolveRequest(batch)
      await this.options.onTurnStarted?.(batch)

      const ownsHistory = !this.options.buildConversation
      const userTurn = ownsHistory ? this.toUserTurn(batch) : undefined
      const conversation = this.options.buildConversation
        ? await this.options.buildConversation(batch, request)
        : {
            turns: [
              { type: 'system', id: 'agent-system', authority: 'system', content: [{ type: 'text', text: request.systemPrompt }] } satisfies Turn,
              ...this.turns,
              userTurn!,
            ],
          }

      await this.options.llm.stream(request.model, request.chatProvider, conversation, {
        abortSignal: controller.signal,
        headers: request.headers,
        providerId: request.providerId,
        temperature: request.temperature,
        topP: request.topP,
        tools: this.limitReceipts(request.tools),
        waitForTools: true,
        requestCorrelation: request.correlation ?? { conversationId: 'agent', turnId: userTurn?.id ?? batch[0]?.id ?? this.createId() },
        onGeneratedTurn: (turn) => { assistantTurn = structuredClone(turn) },
        onUsage: (value) => { usage = value },
        onStreamEvent: async (event) => {
          if (controller.signal.aborted)
            return
          if ((event.type === 'text-delta' && event.text.trim()) || event.type === 'tool-call')
            active.externalized = true
          if (event.type === 'text-delta')
            text += event.text
          if (event.type === 'error')
            throw event.error ?? new Error('Stream error')
          await this.options.onStreamEvent?.(event, batch)
        },
      })

      if (controller.signal.aborted)
        throw controller.signal.reason

      // The turn settled. Only now does the exchange become history, so a cancelled turn leaves none.
      if (userTurn) {
        this.turns.push(userTurn)
        if (assistantTurn)
          this.turns.push(assistantTurn)
        this.trimHistory()
      }
      if (usage?.totalTokens)
        this.spend.push({ at: this.now(), tokens: usage.totalTokens })
      await this.settle({ events: batch, assistantTurn, text, outcome: 'completed', usage, userTurn })
    }
    catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof TurnPreempted && this.running) {
        // Preempted: the events were not answered, so they go back in front of the queue.
        this.bus.requeue(batch)
        await this.settle({ events: batch, text, outcome: 'preempted' })
      }
      else if (controller.signal.aborted) {
        await this.settle({ events: batch, text, outcome: 'cancelled' })
      }
      else if (this.running) {
        await this.settle({ events: batch, text, outcome: 'failed', error })
      }
    }
    finally {
      this.active = undefined
    }
  }

  private async settle(result: AgentTurnResult) {
    try {
      await this.options.onTurnSettled?.(result)
    }
    catch (error) {
      console.error('Agent turn observer failed:', error)
    }
  }

  private limitReceipts(tools: AgentRequest['tools']): StreamOptions['tools'] {
    if (typeof tools === 'function')
      return async () => (await tools())?.map(tool => this.withReceiptLimit(tool))
    return tools?.map(tool => this.withReceiptLimit(tool))
  }

  private withReceiptLimit(tool: Tool): Tool {
    return {
      ...tool,
      execute: async (input, options) => {
        // Tool execution is a visible effect, so a later preempt waits for the turn.
        if (this.active)
          this.active.externalized = true
        return limitReceipt(await tool.execute(input, options), this.maxReceiptChars) as Awaited<ReturnType<Tool['execute']>>
      },
    }
  }

  private trimHistory() {
    // Drop from the front in whole exchanges, so a tool call never loses its result.
    while (this.turns.length > 2 && estimateTokens(this.turns) > this.maxHistoryTokens) {
      const nextUser = this.turns.findIndex((turn, index) => index > 0 && turn.type === 'user')
      if (nextUser === -1)
        return
      this.turns.splice(0, nextUser)
    }
  }
}
