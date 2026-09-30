import type { GenerationProvider } from '@proj-airi/provider-inference'
import type { Tool } from '@xsai/shared-chat'

import type { AgentLLMPort } from '../contracts/llm-port'
import type { AssistantTurn, InputSegment, Turn } from '../messages/types'
import type { LlmUsage, StreamEvent } from '../types/llm'
import type { AgentEvent, AgentEventInput, PushOptions, TriggerMode, WakeBusOptions } from './types'

import { Heartbeat } from './heartbeat'
import { WakeBus } from './wake-bus'

/** Everything the loop needs from the application for one model request. It is read at the start of every turn. */
export interface AgentRequest {
  model: string
  chatProvider: GenerationProvider
  providerId: string
  systemPrompt: string
  tools?: Tool[]
  headers?: Record<string, string>
  temperature?: number
  topP?: number
}

/** What observers see when one turn settles. */
export interface AgentTurnResult {
  /** The events this turn answered, in delivery order. */
  events: AgentEvent[]
  /** Absent when the turn was cancelled or failed. */
  assistantTurn?: AssistantTurn
  text: string
  outcome: 'completed' | 'preempted' | 'failed'
  error?: unknown
  usage?: LlmUsage
}

export interface AgentLoopOptions {
  llm: AgentLLMPort
  resolveRequest: () => AgentRequest | Promise<AgentRequest>
  /** Called for each streamed event of the running turn, in order. Text deltas here are the agent's speech. */
  onStreamEvent?: (event: StreamEvent, batch: AgentEvent[]) => void | Promise<void>
  onTurnStarted?: (events: AgentEvent[]) => void
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
  spendGuard?: { maxTokens: number, windowMs: number }
  now?: () => number
  createId?: () => string
}

const DEFAULT_BUS: WakeBusOptions = {
  quietGapMs: 1500,
  minBatchAgeMs: 500,
  maxBatchAgeMs: 6000,
  maxBatchSize: 8,
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

  /** Cancels the running turn, whatever it has produced, and puts its events back in the queue. */
  interrupt() {
    this.active?.controller.abort(new Error('Agent turn was interrupted'))
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
    const guard = this.options.spendGuard
    if (!guard)
      return false

    const since = this.now() - guard.windowMs
    this.spend = this.spend.filter(entry => entry.at >= since)
    return this.spend.reduce((total, entry) => total + entry.tokens, 0) >= guard.maxTokens
  }

  /** A turn that already spoke or called a tool has visible effects, so a preempt waits for it to finish. */
  private cancelIfNotExternalized() {
    if (this.active && !this.active.externalized)
      this.active.controller.abort(new Error('Agent turn was preempted'))
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

  private async runTurn(batch: AgentEvent[]) {
    const controller = new AbortController()
    const active = { controller, batch, externalized: false }
    this.active = active

    let request: AgentRequest
    let text = ''
    let usage: LlmUsage | undefined
    let assistantTurn: AssistantTurn | undefined

    try {
      request = await this.options.resolveRequest()
      this.options.onTurnStarted?.(batch)

      const userTurn = this.toUserTurn(batch)
      const conversation = {
        turns: [
          { type: 'system', id: 'agent-system', authority: 'system', content: [{ type: 'text', text: request.systemPrompt }] } satisfies Turn,
          ...this.turns,
          userTurn,
        ],
      }

      await this.options.llm.stream(request.model, request.chatProvider, conversation, {
        abortSignal: controller.signal,
        headers: request.headers,
        providerId: request.providerId,
        temperature: request.temperature,
        topP: request.topP,
        tools: request.tools?.map(tool => this.withReceiptLimit(tool)),
        waitForTools: true,
        requestCorrelation: { conversationId: 'agent', turnId: userTurn.id },
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
      this.turns.push(userTurn)
      if (assistantTurn)
        this.turns.push(assistantTurn)
      this.trimHistory()
      if (usage?.totalTokens)
        this.spend.push({ at: this.now(), tokens: usage.totalTokens })
      await this.settle({ events: batch, assistantTurn, text, outcome: 'completed', usage })
    }
    catch (error) {
      if (controller.signal.aborted && this.running) {
        // Preempted or interrupted: the events were not answered, so they go back in front of the queue.
        this.bus.requeue(batch)
        await this.settle({ events: batch, text, outcome: 'preempted' })
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
