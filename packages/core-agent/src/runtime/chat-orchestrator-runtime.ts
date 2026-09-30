import type { GenerationProvider } from '@proj-airi/provider-inference'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { AgentContextPort } from '../contracts/context-port'
import type { AgentLLMPort } from '../contracts/llm-port'
import type { AgentForegroundStreamPort } from '../contracts/stream-port'
import type { AgentEvent, AgentEventInput, AgentRequest, AgentTurnResult, TriggerMode, WakeBusOptions } from '../event-loop'
import type { Conversation, Turn } from '../messages/types'
import type { ChatHistoryItem, ChatSlices, ChatStreamEventContext, ChatToolReference, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { LlmUsage, StreamEvent, StreamOptions } from '../types/llm'

import { createQueue } from '@proj-airi/stream-kit'

import { AgentLoop } from '../event-loop'
import { chatMessagesToTurns } from '../messages/chat-completions'
import { formatTimePrefix } from '../messages/datetime-prefix'
import { renderConversationPreview } from '../messages/preview'
import { createChatHooks } from './agent-hooks'
import { useLlmmarkerParser } from './llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from './response-categoriser'

const REASONING_UI_FLUSH_CHUNK_SIZE = 24

/**
 * Caps repeated reply text in the model prompt. The referenced message remains
 * in history, so the prefix only needs enough text to identify it.
 */
const REPLY_PROMPT_REFERENCE_CHARACTER_LIMIT = 480

function prependTextToContent<T extends { content?: unknown }>(msg: T, text: string): T {
  const content = msg.content
  if (content === undefined)
    return { ...msg, content: text }
  if (typeof content === 'string')
    return { ...msg, content: `${text}${content}` }

  if (Array.isArray(content)) {
    const first = content[0] as { type?: string, text?: string } | undefined
    if (first && first.type === 'text' && typeof first.text === 'string') {
      const next = [{ ...first, text: `${text}${first.text}` }, ...content.slice(1)]
      return { ...msg, content: next }
    }
    return { ...msg, content: [{ type: 'text', text }, ...content] }
  }

  return msg
}

function getMessageText(message: ChatHistoryItem): string {
  if (typeof message.content === 'string')
    return message.content

  if (!Array.isArray(message.content))
    return ''

  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

/**
 * Formats a model-only reference to the message selected by the user.
 *
 * @example
 * formatReplyPromptPrefix('message-1', new Map([
 *   ['message-1', { id: 'message-1', role: 'user', content: 'Earlier turn' }],
 * ]))
 * // => '[Replying to: Earlier turn]\n'
 */
function formatReplyPromptPrefix(replyToMessageId: string | undefined, messagesById: Map<string, ChatHistoryItem>): string {
  if (!replyToMessageId)
    return ''

  const target = messagesById.get(replyToMessageId)
  if (!target)
    return ''

  const targetText = getMessageText(target).replace(/\s+/g, ' ').trim()
  const preview = targetText.length > REPLY_PROMPT_REFERENCE_CHARACTER_LIMIT
    ? `${targetText.slice(0, REPLY_PROMPT_REFERENCE_CHARACTER_LIMIT - 1).trimEnd()}…`
    : targetText
  return preview
    ? `[Replying to: ${preview}]\n`
    : `[Replying to message: ${replyToMessageId}]\n`
}

function resolveReplyTargetId(replyToMessageId: string | undefined, messages: ChatHistoryItem[]): string | undefined {
  if (!replyToMessageId)
    return undefined

  return messages.some(message => message.id === replyToMessageId)
    ? replyToMessageId
    : undefined
}

function cloneStreamingMessage(message: StreamingAssistantMessage): StreamingAssistantMessage {
  try {
    return structuredClone(message)
  }
  catch {
    return JSON.parse(JSON.stringify(message)) as StreamingAssistantMessage
  }
}

function hasAssistantOutput(message: StreamingAssistantMessage) {
  return message.slices.length > 0
    || message.tool_results.length > 0
    || (message.citations?.length ?? 0) > 0
    || !!message.categorization?.reasoning.trim()
}

/**
 * Options accepted by the chat orchestrator runtime for one user send.
 */
export interface ChatOrchestratorSendOptions {
  /** Provider model identifier used for the outbound LLM request. */
  model: string
  /** Concrete chat provider implementation selected by the caller. */
  chatProvider: GenerationProvider
  /** Provider-specific request options, currently used for headers. */
  providerConfig?: Record<string, unknown>
  /** Image attachments appended to the user message content parts. */
  attachments?: { type: 'image', data: string, mimeType: string }[]
  /** Tool definitions passed through to the LLM stream port. */
  tools?: StreamOptions['tools']
  /** Serializable tool names stored with the user message for later requests. */
  toolReferences?: ChatToolReference[]
  /** Original transport input metadata used by bridge/devtools observers. */
  input?: ChatStreamEventContext['input']
  /** Message that the new user turn replies to in the target session. */
  replyToMessageId?: string
  /** Temperature for the LLM request. */
  temperature?: number
  /** Top_p for the LLM request. */
  topP?: number
}

interface QueuedSend {
  /** Keep provider identity paired with the client captured at enqueue time. */
  providerId: string
  sendingMessage: string
  options: ChatOrchestratorSendOptions
  generation: number
  sessionId: string
  cancelled?: boolean
  deferred: {
    resolve: () => void
    reject: (error: unknown) => void
  }
}

/**
 * Serializable view of a queued send waiting to be processed.
 */
export interface QueuedSendSnapshot {
  /** Session that owns the queued send. */
  sessionId: string
  /** Session generation captured when the send was enqueued. */
  generation: number
  /** Whether the queued send has been rejected before execution. */
  cancelled: boolean
  /** First 120 characters of the pending user message. */
  messagePreview: string
  /** Whether the queued send carries image attachments. */
  hasAttachments: boolean
  /** Optional input event type for transport-originated sends. */
  inputType?: NonNullable<ChatStreamEventContext['input']>['type']
}

/**
 * Session operations required by the core chat orchestrator runtime.
 */
export interface ChatOrchestratorSessionPort {
  /** Ensures a session exists before messages are appended. */
  ensureSession: (sessionId: string) => void
  /** Returns chronological chat history for a session. */
  getSessionMessages: (sessionId: string) => ChatHistoryItem[]
  /** Appends a finalized user/assistant/tool history item. */
  appendSessionMessage: (sessionId: string, message: ChatHistoryItem) => void
  /** Returns a monotonic generation used to reject stale queued sends. */
  getSessionGeneration: (sessionId: string) => number
}

/**
 * LLM streaming boundary used by the core chat orchestrator runtime.
 */
export type ChatOrchestratorLLMPort = AgentLLMPort

/**
 * Lifecycle record emitted around prompt composition.
 */
export interface ChatOrchestratorLifecycleRecord {
  /** Composition phase being observed. */
  phase: 'before-compose' | 'prompt-context-built' | 'after-compose'
  /** Logical event channel for context observability. */
  channel: 'chat'
  /** Session associated with this send. */
  sessionId: string
  /** Optional compact preview of the user text. */
  textPreview?: string
  /** Phase-specific payload for devtools and diagnostics. */
  details?: unknown
}

/**
 * Prompt projection emitted after the runtime has composed provider messages.
 */
export interface ChatOrchestratorPromptProjection {
  /** Session associated with the projected prompt. */
  sessionId: string
  /** Raw user message text that triggered the prompt. */
  message: string
  /** Active context snapshot read during prompt composition. */
  contexts: Record<string, ContextMessage[]>
  /** Historical standalone context prompt shape, kept for compatibility. */
  promptMessage?: Message | null
  /** Display projection for hooks and diagnostics. This is not an API payload. */
  composedMessage?: Message[]
}

/**
 * Reactive state mirrored by UI facades.
 */
export interface ChatOrchestratorRuntimeState {
  /** Whether the runtime currently owns an active send. */
  sending: boolean
  /** Session that owns the active send; undefined while the queue is idle. */
  activeSendSessionId?: string
  /** Latest assistant stream snapshot owned by the active send session. */
  activeStreamingMessage?: StreamingAssistantMessage
  /** Number of sends waiting behind the active one. */
  pendingQueuedSendCount: number
}

/** Correlation keys shared by every analytics milestone from one user-to-assistant round. */
interface ChatRoundCorrelation {
  /** Application conversation that owns the round. */
  conversationId: string
  /** Stable round key; the runtime reuses the persisted user-message ID. */
  roundId: string
  /** One-based user turn position within the conversation. */
  turnIndex: number
}

/**
 * Dependency surface used by the platform-agnostic chat orchestrator runtime.
 */
export interface ChatOrchestratorRuntimeDeps {
  /** Session persistence and generation guard port. */
  session: ChatOrchestratorSessionPort
  /** Context registry facade used for runtime context ingest and prompt snapshots. */
  context: Pick<AgentContextPort, 'ingest' | 'snapshot'>
  /** Foreground assistant stream port controlled by the UI facade. */
  foregroundStream: AgentForegroundStreamPort
  /** Provider-agnostic LLM streaming port. */
  llm: ChatOrchestratorLLMPort
  /** Returns the currently visible session ID. */
  getActiveSessionId: () => string
  /** Returns the currently active provider ID for categorization policy. */
  getActiveProvider: () => string | undefined
  /** Returns optional prompt text appended to the provider system message for this send. */
  getSystemPromptSupplement?: () => string | undefined
  /** Runtime context providers ingested immediately before prompt composition. */
  runtimeContextProviders?: Array<() => ContextMessage | null | undefined>
  /** Clock used for persisted message timestamps. @default Date.now */
  now?: () => number
  /** Monotonic clock used for elapsed telemetry in milliseconds. @default performance.now */
  monotonicNow?: () => number
  /** ID factory used for persisted chat messages. @default crypto.randomUUID fallback */
  createId?: () => string
  /** Optional adapter for removing framework proxies before provider composition. */
  unwrapMessage?: <T>(message: T) => T
  /** Called whenever writable runtime state changes. */
  onStateChange?: (state: ChatOrchestratorRuntimeState) => void
  /** Called after a runtime-owned send completes or fails and `sending` has been cleared. */
  onSendSettled?: (event: { sessionId: string }) => void
  /** Called when a send starts and the first assistant placeholder is created. */
  onTrackFirstMessage?: () => void
  /** Called for attempts made before the conversation has its first assistant response. */
  onChatActivationStarted?: (event: ChatRoundCorrelation & {
    source: 'text' | 'voice'
    model: string
    provider: string
  }) => void
  /** Called when the conversation reaches its first successful assistant response. */
  onChatActivationSucceeded?: (event: ChatRoundCorrelation & {
    source: 'text' | 'voice'
    model: string
    provider: string
    durationMs: number
  }) => void
  /** Called when a pre-activation attempt fails before assistant completion. */
  onChatActivationFailed?: (event: ChatRoundCorrelation & {
    source: 'text' | 'voice'
    model: string
    provider: string
    failureStage: 'llm_response'
    errorCode: 'llm_response_failed'
  }) => void
  /** Called when a user message send begins. */
  onMessageSendStarted?: (event: ChatRoundCorrelation & {
    source: 'text' | 'voice'
    model: string
  }) => void
  /** Called immediately before the provider LLM request starts. */
  onLlmRequestStarted?: (event: ChatRoundCorrelation & {
    model: string
    provider: string
    hasVoice: boolean
  }) => void
  /** Called when the first text token arrives from the provider stream. */
  onLlmFirstToken?: (event: ChatRoundCorrelation & {
    model: string
    ttfbMs: number
  }) => void
  /** Called after the assistant stream is parsed and rendered into runtime state. */
  onAssistantResponseRendered?: (event: ChatRoundCorrelation & {
    model: string
    latencyMs: number
  }) => void
  /** Called once per completed provider generation with content-free usage metadata. */
  onLlmGeneration?: (event: ChatRoundCorrelation & {
    model: string
    provider: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    usageSource: LlmUsage['source']
  }) => void
  /** Called after one user-to-assistant message round completes successfully. */
  onMessageRound?: (event: ChatRoundCorrelation & {
    durationMs: number
    hasVoice: boolean
    model: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    usageSource: LlmUsage['source']
  }) => void
  /** Called whenever a user-to-assistant round fails before completion. */
  onMessageRoundFailed?: (event: ChatRoundCorrelation & {
    source: 'text' | 'voice'
    model: string
    provider: string
    failureStage: 'llm_response'
    errorCode: 'llm_response_failed'
  }) => void
  /** Called for context/prompt lifecycle observability. */
  onLifecycle?: (record: ChatOrchestratorLifecycleRecord) => void
  /** Called with the final provider prompt projection. */
  onPromptProjection?: (payload: ChatOrchestratorPromptProjection) => void
  /** Called after the user message has been appended to session history. */
  onUserMessageAppended?: (event: {
    sessionId: string
    message: Extract<ChatHistoryItem, { role: 'user' }> & { id: string }
    messageText: string
    source: 'text' | 'voice'
    model: string
    provider: string
    roundId: string
    turnIndex: number
  }) => void
  /** Called after the assistant message has been finalized into session history. */
  onAssistantMessageAppended?: (event: {
    sessionId: string
    message: StreamingAssistantMessage
    messageText: string
  }) => void
  /**
   * Model and provider for a turn that no chat send started, such as a plugin event or a heartbeat.
   * Return `undefined` when none is configured. The turn then fails without a stored error message.
   */
  resolveAgentRequest?: () => Promise<Pick<AgentRequest, 'model' | 'chatProvider' | 'providerId' | 'tools' | 'headers' | 'temperature' | 'topP'> | undefined>
  /** Debounce timing of the wake bus. */
  bus?: Partial<WakeBusOptions>
  /** Base heartbeat interval in milliseconds, read at each beat. No value means no heartbeat. */
  heartbeatMs?: () => number | undefined
  /** Stops debounce and heartbeat wakes while a token budget for a time window is used up. */
  spendGuard?: { maxTokens: number, windowMs: number }
  /** Longest tool receipt handed to the model. @default 20000 */
  maxReceiptChars?: number
  /** Called after user turn persistence, before provider prompt composition. */
  onUserTurnReady?: (event: {
    messageText: string
    sessionMessages: ChatHistoryItem[]
  }) => void
  /** Called after assistant streaming and hook finalization. */
  onAssistantTurnReady?: (event: {
    messageText: string
    sessionMessages: ChatHistoryItem[]
  }) => void
}

/**
 * Platform-agnostic chat orchestrator runtime API.
 */
export interface ChatOrchestratorRuntime {
  /** Sends a user message to the agent for the target session. Resolves when the turn that answers it ends. */
  ingest: (sendingMessage: string, options: ChatOrchestratorSendOptions, targetSessionId?: string) => Promise<void>
  /** Rejects queued sends that have not started yet. */
  cancelPendingSends: (sessionId?: string) => void
  /** Returns serializable snapshots of currently queued sends. */
  getPendingQueuedSendSnapshot: () => QueuedSendSnapshot[]
  /** Returns the current queued send count. */
  getPendingQueuedSendCount: () => number
  /** Reads the writable sending flag. */
  getSending: () => boolean
  /** Updates the writable sending flag and notifies facade mirrors. */
  setSending: (next: boolean) => void
  /**
   * Pushes an event from a plugin or another source. The agent answers it in the current session.
   * Returns `undefined` after `stop`. `trigger` defaults to `debounce` for external events.
   */
  pushEvent: (input: AgentEventInput, options?: { trigger?: TriggerMode }) => AgentEvent | undefined
  /** Stops the agent loop and its heartbeat. Later sends and events are dropped. */
  stop: () => Promise<void>
  /** Hook registry preserved from the previous stage-ui store API. */
  hooks: ReturnType<typeof createChatHooks>
}

function defaultCreateId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Creates the core chat orchestrator runtime used behind UI facades.
 *
 * Use when:
 * - A platform wants AIRI chat send orchestration without Vue/Pinia coupling.
 * - Session, context, foreground stream, and LLM integrations are provided as adapters.
 *
 * Expects:
 * - Session messages are returned in chronological order.
 * - `foregroundStream.patch` replaces the visible streaming assistant message.
 *
 * Returns:
 * - A runtime with send queue APIs, hook registry, writable sending state, and queue snapshots.
 */
export function createChatOrchestratorRuntime(deps: ChatOrchestratorRuntimeDeps): ChatOrchestratorRuntime {
  const hooks = createChatHooks()
  const now = deps.now ?? (() => Date.now())
  const monotonicNow = deps.monotonicNow ?? (() => globalThis.performance?.now?.() ?? Date.now())
  const createId = deps.createId ?? defaultCreateId
  const unwrapMessage = deps.unwrapMessage ?? (<T>(message: T) => message)

  let sending = false
  let activeSendSessionId: string | undefined
  let activeStreamingMessage: StreamingAssistantMessage | undefined
  let pendingQueuedSends: QueuedSend[] = []

  function emitStateChange() {
    deps.onStateChange?.({
      sending,
      activeSendSessionId,
      activeStreamingMessage,
      pendingQueuedSendCount: pendingQueuedSends.length,
    })
  }

  function setSending(next: boolean) {
    const nextActiveSendSessionId = next
      ? activeSendSessionId ?? deps.getActiveSessionId()
      : undefined
    if (sending === next && activeSendSessionId === nextActiveSendSessionId)
      return
    sending = next
    activeSendSessionId = nextActiveSendSessionId
    if (!next)
      activeStreamingMessage = undefined
    emitStateChange()
  }

  function isForegroundSession(sessionId: string) {
    return sessionId === deps.getActiveSessionId()
  }

  function beginStream(sessionId: string, message: StreamingAssistantMessage) {
    sending = true
    activeSendSessionId = sessionId
    activeStreamingMessage = cloneStreamingMessage(message)
    emitStateChange()

    if (isForegroundSession(sessionId))
      deps.foregroundStream.patch(cloneStreamingMessage(message))
  }

  function updateStream(sessionId: string, message: StreamingAssistantMessage) {
    if (sessionId === activeSendSessionId) {
      activeStreamingMessage = cloneStreamingMessage(message)
      emitStateChange()
    }

    if (isForegroundSession(sessionId))
      deps.foregroundStream.patch(cloneStreamingMessage(message))
  }

  function resetForegroundStream(sessionId: string) {
    if (isForegroundSession(sessionId))
      deps.foregroundStream.reset()
  }

  function ingestRuntimeContexts() {
    for (const provider of deps.runtimeContextProviders ?? []) {
      const contextMessage = provider()
      if (contextMessage)
        deps.context.ingest(contextMessage)
    }
  }

  function getStablePromptTimestamp(message: ChatHistoryItem, fallbackCreatedAt: number) {
    if (typeof message.createdAt === 'number')
      return message.createdAt

    message.createdAt = fallbackCreatedAt
    return fallbackCreatedAt
  }

  function buildContext(history: ChatHistoryItem[]): Conversation {
    const nowTs = now()
    const messagesById = new Map(history.flatMap(message => message.id ? [[message.id, message] as const] : []))
    const turns = history.flatMap((message, historyIndex): Turn[] => {
      if (message.role === 'assistant' && message.generationTranscript)
        return [structuredClone(unwrapMessage(message.generationTranscript))]
      const source = message.role === 'user'
        ? prependTextToContent(unwrapMessage(message), `${formatTimePrefix(getStablePromptTimestamp(message, nowTs))}${formatReplyPromptPrefix(message.replyToMessageId, messagesById)}`)
        : unwrapMessage(message)
      return chatMessagesToTurns(source.role === 'assistant' && source.providerTranscript?.length ? source.providerTranscript : [source], message.id ?? `history-${historyIndex}`)
    })
    return { turns }
  }
  /** What a chat event carries for the runtime. Other events have no `send`. */
  interface EventMeta {
    send?: QueuedSend
  }

  function sendOf(event: AgentEvent): QueuedSend | undefined {
    return (event.meta as EventMeta | undefined)?.send
  }

  function isStaleSend(send: QueuedSend) {
    return send.cancelled === true || deps.session.getSessionGeneration(send.sessionId) !== send.generation
  }

  function removePendingSend(send: QueuedSend) {
    if (!pendingQueuedSends.includes(send))
      return
    pendingQueuedSends = pendingQueuedSends.filter(item => item !== send)
    emitStateChange()
  }

  /** The state of the one turn that runs now. A turn lives from `resolveRequest` until `settle`. */
  interface TurnState {
    sessionId: string
    generation: number
    /** The chat send whose options and text drive this turn, if a chat event is in the batch. */
    primary?: QueuedSend
    messageText: string
    assistantMessageId: string
    roundId: string
    streamContextMessageId: string
    correlation: ChatRoundCorrelation
    streamContext: ChatStreamEventContext
    building: StreamingAssistantMessage
    hasVoice: boolean
    sendSource: 'text' | 'voice'
    isActivationAttempt: boolean
    roundStartedAt: number
    llmRequestStartedAt: number
    llmFirstTokenEmitted: boolean
    fullText: string
    sessionMessagesForSend: ChatHistoryItem[]
    parser?: ReturnType<typeof useLlmmarkerParser>
    toolCallQueue?: ReturnType<typeof createQueue<ChatSlices>>
    model: string
    providerId: string
  }

  /**
   * Events whose user message is already in the session. A preempted turn returns its events to the queue,
   * and the next turn must not store them a second time.
   */
  const persistedEvents = new Set<string>()
  let turn: TurnState | undefined

  function isStaleGeneration(state: TurnState) {
    return deps.session.getSessionGeneration(state.sessionId) !== state.generation
  }

  function userMessageFrom(event: AgentEvent, id: string, replyToMessageId: string | undefined, createdAt: number): ChatHistoryItem {
    const send = sendOf(event)
    if (!send) {
      return { role: 'user', content: event.text, createdAt, id, agentEvent: { type: event.type, source: event.source } }
    }

    const contentParts: CommonContentPart[] = [{ type: 'text', text: send.sendingMessage }]
    for (const attachment of send.options.attachments ?? []) {
      if (attachment.type === 'image')
        contentParts.push({ type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` } })
    }

    return {
      role: 'user',
      content: contentParts.length > 1 ? contentParts : send.sendingMessage,
      createdAt,
      id,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(send.options.toolReferences?.length ? { tools: send.options.toolReferences } : {}),
    }
  }

  /**
   * Chooses the events one turn answers: all events of one session, in arrival order. Events that name no
   * session, such as plugin events and heartbeats, join whichever session the turn belongs to.
   */
  function selectEvents(batch: AgentEvent[]) {
    const sessionId = batch.map(sendOf).find(send => send)?.sessionId
    return batch.filter((event) => {
      const send = sendOf(event)
      return !send || send.sessionId === sessionId
    })
  }

  async function resolveRequest(batch: AgentEvent[]): Promise<AgentRequest> {
    const primary = batch.map(sendOf).find(send => send)
    const sessionId = primary?.sessionId ?? deps.getActiveSessionId()
    const fallback = primary ? undefined : await deps.resolveAgentRequest?.()
    if (!primary && !fallback)
      throw new Error('No active chat provider or model configured')

    // Allocate the three per-round ids in their historical order so callers
    // with deterministic id factories keep the same durable message ids.
    const streamContextMessageId = createId()
    const assistantMessageId = createId()
    const roundId = createId()
    const sendingCreatedAt = now()
    const existingSessionMessages = deps.session.getSessionMessages(sessionId)
    const messageText = primary?.sendingMessage ?? batch.map(event => event.text).join('\n')
    const hasVoice = primary?.options.input?.type === 'input:voice'
      || primary?.options.input?.type === 'input:text:voice'
    const model = primary?.options.model ?? fallback!.model
    const providerId = primary?.providerId ?? fallback!.providerId

    turn = {
      sessionId,
      generation: deps.session.getSessionGeneration(sessionId),
      primary,
      messageText,
      assistantMessageId,
      roundId,
      streamContextMessageId,
      model,
      providerId,
      correlation: {
        conversationId: sessionId,
        roundId,
        // A round without a chat send does not count as a user turn.
        turnIndex: existingSessionMessages.filter(message => message.role === 'user').length + 1,
      },
      streamContext: {
        turnId: roundId,
        message: { role: 'user', content: messageText, createdAt: sendingCreatedAt, id: streamContextMessageId },
        contexts: deps.context.snapshot(),
        composedMessage: [],
        input: primary?.options.input,
      },
      building: { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: now(), id: assistantMessageId },
      hasVoice,
      sendSource: hasVoice ? 'voice' : 'text',
      // Activation measures whether a conversation reaches its first assistant
      // response. Later turns still emit message and latency telemetry, but they
      // must not inflate the one-time activation milestones.
      isActivationAttempt: !existingSessionMessages.some(message => message.role === 'assistant' && !message.interrupted),
      roundStartedAt: monotonicNow(),
      llmRequestStartedAt: 0,
      llmFirstTokenEmitted: false,
      fullText: '',
      sessionMessagesForSend: [],
    }

    return {
      model,
      chatProvider: primary?.options.chatProvider ?? fallback!.chatProvider,
      providerId,
      // The conversation comes from the stored session, which already holds the system prompt.
      systemPrompt: '',
      tools: primary ? primary.options.tools : fallback!.tools,
      headers: (primary?.options.providerConfig?.headers ?? fallback?.headers ?? {}) as Record<string, string>,
      temperature: primary ? primary.options.temperature : fallback!.temperature,
      topP: primary ? primary.options.topP : fallback!.topP,
      correlation: { conversationId: sessionId, turnId: roundId },
    }
  }

  /** Stores the user messages of the batch and prepares the stream. Runs before the conversation is built. */
  async function onTurnStarted(batch: AgentEvent[]) {
    const state = turn!
    const { sessionId, primary } = state
    deps.session.ensureSession(sessionId)
    ingestRuntimeContexts()
    state.streamContext.contexts = deps.context.snapshot()

    for (const event of batch)
      removePendingSendOf(event)

    deps.onLifecycle?.({
      phase: 'before-compose',
      channel: 'chat',
      sessionId,
      textPreview: state.messageText,
      details: { contexts: state.streamContext.contexts },
    })

    if (isStaleGeneration(state))
      return

    beginStream(sessionId, state.building)
    deps.onTrackFirstMessage?.()
    if (primary) {
      if (state.isActivationAttempt) {
        deps.onChatActivationStarted?.({
          ...state.correlation,
          source: state.sendSource,
          model: state.model,
          provider: state.providerId,
        })
      }
      deps.onMessageSendStarted?.({ ...state.correlation, source: state.sendSource, model: state.model })
    }

    await hooks.emitBeforeMessageComposedHooks(state.messageText, state.streamContext)

    if (!state.streamContext.input) {
      state.streamContext.input = { type: 'input:text', data: { text: state.messageText } }
    }

    if (isStaleGeneration(state))
      return

    const replyToMessageId = resolveReplyTargetId(primary?.options.replyToMessageId, deps.session.getSessionMessages(sessionId))
    if (replyToMessageId)
      state.streamContext.message.replyToMessageId = replyToMessageId
    else
      delete state.streamContext.message.replyToMessageId

    for (const event of batch) {
      if (persistedEvents.has(event.id))
        continue

      const send = sendOf(event)
      const isPrimary = send !== undefined && send === primary
      const message = userMessageFrom(event, isPrimary ? state.roundId : event.id, isPrimary ? replyToMessageId : undefined, isPrimary ? state.streamContext.message.createdAt! : now())
      deps.session.appendSessionMessage(sessionId, message)
      persistedEvents.add(event.id)

      // Cloud sync v1: only the raw text part round-trips; image attachments
      // and other non-text parts stay local.
      if (isPrimary && primary) {
        deps.onUserMessageAppended?.({
          sessionId,
          message: message as Extract<ChatHistoryItem, { role: 'user' }> & { id: string },
          messageText: primary.sendingMessage,
          source: state.sendSource,
          model: state.model,
          provider: state.providerId,
          roundId: state.roundId,
          turnIndex: state.correlation.turnIndex,
        })
      }
    }

    state.sessionMessagesForSend = deps.session.getSessionMessages(sessionId)
    deps.onUserTurnReady?.({ messageText: state.messageText, sessionMessages: state.sessionMessagesForSend })

    const categorizer = createStreamingCategorizer(deps.getActiveProvider())
    let streamPosition = 0

    state.parser = useLlmmarkerParser({
      onLiteral: async (literal) => {
        if (isStaleGeneration(state))
          return

        categorizer.consume(literal)

        const speechOnly = categorizer.filterToSpeech(literal, streamPosition)
        streamPosition += literal.length

        if (speechOnly.trim()) {
          state.building.content += speechOnly

          await hooks.emitTokenLiteralHooks(speechOnly, state.streamContext)

          const lastSlice = state.building.slices.at(-1)
          if (lastSlice?.type === 'text')
            lastSlice.text += speechOnly
          else
            state.building.slices.push({ type: 'text', text: speechOnly })
          updateStream(sessionId, state.building)
        }
      },
      onSpecial: async (special) => {
        if (isStaleGeneration(state))
          return

        await hooks.emitTokenSpecialHooks(special, state.streamContext)
      },
      onEnd: async (fullText) => {
        if (isStaleGeneration(state))
          return

        const finalCategorization = categorizeResponse(fullText, deps.getActiveProvider())

        const reasoningContentField = state.building.categorization?.reasoning?.trim()
        state.building.categorization = {
          speech: finalCategorization.speech,
          reasoning: reasoningContentField || finalCategorization.reasoning,
        }
        updateStream(sessionId, state.building)
      },
      // The parser keeps its own marker-safety tail. Emit each safe literal
      // chunk so slow providers update the chat before they reach 24 characters.
      minLiteralEmitLength: 1,
    })

    state.toolCallQueue = createQueue<ChatSlices>({
      handlers: [
        async (ctx) => {
          if (isStaleGeneration(state))
            return
          if (ctx.data.type === 'tool-call') {
            state.building.slices.push(ctx.data)
            updateStream(sessionId, state.building)
            return
          }

          if (ctx.data.type === 'tool-call-result') {
            state.building.tool_results.push(ctx.data)
            updateStream(sessionId, state.building)
          }
        },
      ],
    })
  }

  function removePendingSendOf(event: AgentEvent) {
    const send = sendOf(event)
    if (send)
      removePendingSend(send)
  }

  /** Composes the request conversation from the stored session and runs the pre-send hooks. */
  async function buildConversation(): Promise<Conversation> {
    const state = turn!
    const { sessionId } = state
    const context = buildContext(state.sessionMessagesForSend)
    const systemPromptSupplement = deps.getSystemPromptSupplement?.()?.trim()
    if (systemPromptSupplement) {
      const systemMessage = context.turns.find(item => item.type === 'system' && item.authority === 'system')
      if (systemMessage?.type === 'system')
        systemMessage.content.push({ type: 'text', text: `\n\n${systemPromptSupplement}` })
      else
        context.turns.unshift({ id: 'system-supplement', type: 'system', authority: 'system', content: [{ type: 'text', text: systemPromptSupplement }] })
    }

    const contextsSnapshot = deps.context.snapshot()
    const entries = Object.entries(contextsSnapshot).flatMap(([source, messages]) => messages.map(message => ({ source, text: message.text })))
    if (entries.length) {
      const lastMessage = context.turns.at(-1)
      if (lastMessage?.type === 'user')
        lastMessage.content.push({ type: 'runtime-context', entries })
      deps.onLifecycle?.({ phase: 'prompt-context-built', channel: 'chat', sessionId, details: { contexts: contextsSnapshot } })
    }

    // Hooks, diagnostics, and the plugin bridge consume a display projection. It contains
    // no native continuation state and never becomes a provider request.
    state.streamContext.composedMessage = renderConversationPreview(context)
    deps.onPromptProjection?.({
      sessionId,
      message: state.messageText,
      contexts: contextsSnapshot,
      composedMessage: state.streamContext.composedMessage,
    })
    deps.onLifecycle?.({
      phase: 'after-compose',
      channel: 'chat',
      sessionId,
      textPreview: state.messageText,
      details: { composedMessage: state.streamContext.composedMessage },
    })

    await hooks.emitAfterMessageComposedHooks(state.messageText, state.streamContext)
    await hooks.emitBeforeSendHooks(state.messageText, state.streamContext)

    state.llmRequestStartedAt = monotonicNow()
    if (state.primary) {
      deps.onLlmRequestStarted?.({
        ...state.correlation,
        model: state.model,
        provider: deps.getActiveProvider() || 'unknown',
        hasVoice: state.hasVoice,
      })
    }
    return context
  }

  async function onStreamEvent(event: StreamEvent) {
    const state = turn
    if (!state || isStaleGeneration(state))
      return

    const { sessionId, building } = state
    switch (event.type) {
      case 'search':
        building.search = { id: event.id, status: event.status }
        updateStream(sessionId, building)
        break
      case 'citations':
        building.citations = [...(building.citations ?? []), ...event.citations]
        updateStream(sessionId, building)
        break
      case 'tool-call':
        state.toolCallQueue?.enqueue({ type: 'tool-call', toolCall: event })
        break
      case 'tool-result':
        state.toolCallQueue?.enqueue({ type: 'tool-call-result', id: event.toolCallId, result: event.result })
        break
      case 'tool-error':
        state.toolCallQueue?.enqueue({ type: 'tool-call-result', id: event.toolCallId, isError: true, result: event.result })
        break
      case 'text-delta':
        if (!state.llmFirstTokenEmitted) {
          state.llmFirstTokenEmitted = true
          if (state.primary) {
            deps.onLlmFirstToken?.({
              ...state.correlation,
              model: state.model,
              ttfbMs: Math.round(monotonicNow() - state.llmRequestStartedAt),
            })
          }
        }
        state.fullText += event.text
        await state.parser?.consume(event.text)
        break
      case 'reasoning-delta': {
        const { reasoning = '' } = building.categorization ?? {}
        const nextReasoning = reasoning + event.text
        building.categorization = {
          speech: typeof building.content === 'string' ? building.content : '',
          reasoning: nextReasoning,
        }
        const crossesBoundary
          = Math.floor(nextReasoning.length / REASONING_UI_FLUSH_CHUNK_SIZE)
            > Math.floor(reasoning.length / REASONING_UI_FLUSH_CHUNK_SIZE)
        if (!reasoning || crossesBoundary)
          updateStream(sessionId, building)
        break
      }
      case 'finish':
        break
      case 'error':
        throw event.error ?? new Error('Stream error')
    }
  }

  /** Records the outcome of the turn that ran. Every outcome ends with the sending flag cleared. */
  async function onTurnSettled(result: AgentTurnResult) {
    const state = turn
    if (!state) {
      // The turn failed before it had state, for example while no provider is configured. No chat send
      // can be in such a batch, because a send always carries its own provider.
      if (result.outcome === 'failed')
        console.error('Agent turn could not start:', result.error)
      return
    }

    const { sessionId, building } = state
    const chatSends = result.events.flatMap((event) => {
      const send = sendOf(event)
      return send ? [send] : []
    })
    let assistantStored = false

    try {
      if (result.outcome === 'preempted') {
        // The events return to the queue and the next turn answers them. Nothing this turn showed stays.
        resetForegroundStream(sessionId)
        return
      }

      if (result.outcome === 'failed') {
        if (isStaleGeneration(state))
          return

        if (hasAssistantOutput(building)) {
          // Keep received output local, but do not run completion hooks or cloud
          // sync for an assistant turn that never reached a terminal event.
          deps.session.appendSessionMessage(sessionId, { ...cloneStreamingMessage(building), interrupted: true })
        }
        resetForegroundStream(sessionId)

        console.error('Error sending message:', result.error)
        if (state.primary) {
          deps.onMessageRoundFailed?.({
            ...state.correlation,
            source: state.sendSource,
            model: state.model,
            provider: state.providerId,
            failureStage: 'llm_response',
            errorCode: 'llm_response_failed',
          })
          if (state.isActivationAttempt) {
            deps.onChatActivationFailed?.({
              ...state.correlation,
              source: state.sendSource,
              model: state.model,
              provider: state.providerId,
              failureStage: 'llm_response',
              errorCode: 'llm_response_failed',
            })
          }
        }
        for (const send of chatSends)
          send.deferred.reject(result.error)
        return
      }

      if (result.outcome === 'cancelled') {
        if (!isStaleGeneration(state) && hasAssistantOutput(building)) {
          deps.session.appendSessionMessage(sessionId, { ...cloneStreamingMessage(building), interrupted: true })
          resetForegroundStream(sessionId)
        }
        for (const send of chatSends)
          send.deferred.resolve()
        return
      }

      // Session generation is the lifecycle correlation key. Re-check it
      // after every awaited completion boundary so deleting a session while a
      // plugin hook runs cannot leak later hooks or success analytics.
      if (isStaleGeneration(state))
        return

      await state.parser?.end()
      if (isStaleGeneration(state))
        return

      building.generationTranscript = result.assistantTurn
      if (state.primary) {
        try {
          deps.onAssistantResponseRendered?.({
            ...state.correlation,
            model: state.model,
            latencyMs: Math.round(monotonicNow() - state.llmRequestStartedAt),
          })
        }
        catch (error) {
          console.error('Assistant response observer failed:', error)
        }
        if (result.usage) {
          deps.onLlmGeneration?.({
            ...state.correlation,
            model: state.model,
            provider: state.providerId,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            usageSource: result.usage.source,
          })
        }
      }

      if (building.slices.length > 0 || result.assistantTurn?.rounds.length) {
        deps.session.appendSessionMessage(sessionId, building)
        assistantStored = true
        deps.onAssistantMessageAppended?.({ sessionId, message: building, messageText: state.fullText })
      }

      await hooks.emitStreamEndHooks(state.streamContext)
      await hooks.emitAssistantResponseEndHooks(state.fullText, state.streamContext)
      await hooks.emitAfterSendHooks(state.messageText, state.streamContext)
      await hooks.emitAssistantMessageHooks({ ...building }, state.fullText, state.streamContext)
      await hooks.emitChatTurnCompleteHooks({
        output: { ...building },
        outputText: state.fullText,
        toolCalls: state.sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
      }, state.streamContext)

      deps.onAssistantTurnReady?.({ messageText: state.fullText, sessionMessages: state.sessionMessagesForSend })

      resetForegroundStream(sessionId)
      if (state.primary) {
        const durationMs = Math.round(monotonicNow() - state.roundStartedAt)
        deps.onMessageRound?.({
          ...state.correlation,
          durationMs,
          hasVoice: state.hasVoice,
          model: state.model,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
          usageSource: result.usage?.source ?? 'unavailable',
        })
        if (state.isActivationAttempt) {
          deps.onChatActivationSucceeded?.({
            ...state.correlation,
            durationMs,
            source: state.sendSource,
            model: state.model,
            provider: state.providerId,
          })
        }
      }
      for (const send of chatSends)
        send.deferred.resolve()
    }
    catch (error) {
      // A hook or observer failed after generation. The send fails the same way a stream error does.
      if (!assistantStored)
        resetForegroundStream(sessionId)
      console.error('Error sending message:', error)
      for (const send of chatSends)
        send.deferred.reject(error)
    }
    finally {
      // A stale session leaves its sends unresolved above. Settle them so callers never hang.
      if (isStaleGeneration(state)) {
        for (const send of chatSends)
          send.deferred.resolve()
      }
      turn = undefined
      setSending(false)
      deps.onSendSettled?.({ sessionId })
    }
  }

  const loop = new AgentLoop({
    llm: deps.llm,
    resolveRequest,
    buildConversation,
    selectEvents,
    isStale: (event) => {
      const send = sendOf(event)
      return send !== undefined && isStaleSend(send)
    },
    onDiscarded: (events) => {
      for (const event of events) {
        const send = sendOf(event)
        if (!send)
          continue
        removePendingSend(send)
        // A cancelled send was already rejected by `cancelPendingSends`.
        if (!send.cancelled)
          send.deferred.reject(new Error('Chat session was reset before send could start'))
      }
    },
    onTurnStarted,
    onStreamEvent,
    onTurnSettled,
    bus: deps.bus,
    heartbeatMs: deps.heartbeatMs,
    spendGuard: deps.spendGuard,
    maxReceiptChars: deps.maxReceiptChars,
    now,
  })
  loop.start()

  function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    if (!sendingMessage && !options.attachments?.length)
      return Promise.resolve()

    const sessionId = targetSessionId || deps.getActiveSessionId()
    const generation = deps.session.getSessionGeneration(sessionId)

    return new Promise<void>((resolve, reject) => {
      const send: QueuedSend = {
        providerId: deps.getActiveProvider?.() ?? '',
        sendingMessage,
        options,
        generation,
        sessionId,
        deferred: { resolve, reject },
      }
      pendingQueuedSends.push(send)
      emitStateChange()
      // Chat is the one input that always wakes the agent at once.
      loop.push({ type: 'chat.message', source: 'chat', text: sendingMessage, meta: { send } }, { trigger: 'flush' })
    })
  }

  function pushEvent(input: AgentEventInput, options?: { trigger?: TriggerMode }) {
    return loop.push(input, options)
  }

  function cancelPendingSends(sessionId?: string) {
    const matches = (send: QueuedSend) => !sessionId || send.sessionId === sessionId
    loop.interrupt((event) => {
      const send = sendOf(event)
      return send !== undefined && matches(send)
    })

    for (const queued of pendingQueuedSends) {
      if (!matches(queued))
        continue

      queued.cancelled = true
      queued.deferred.reject(new Error('Chat session was reset before send could start'))
    }

    pendingQueuedSends = pendingQueuedSends.filter(item => !matches(item))
    emitStateChange()
  }

  function getPendingQueuedSendSnapshot() {
    return pendingQueuedSends.map(queued => ({
      sessionId: queued.sessionId,
      generation: queued.generation,
      cancelled: !!queued.cancelled,
      messagePreview: queued.sendingMessage.slice(0, 120),
      hasAttachments: !!queued.options.attachments?.length,
      inputType: queued.options.input?.type,
    } satisfies QueuedSendSnapshot))
  }

  return {
    ingest,
    pushEvent,
    cancelPendingSends,
    getPendingQueuedSendSnapshot,
    getPendingQueuedSendCount: () => pendingQueuedSends.length,
    getSending: () => sending,
    setSending,
    stop: () => loop.stop(),
    hooks,
  }
}
