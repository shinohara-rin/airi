import type { Client } from '@proj-airi/server-sdk'

import type { ConnectorConfig } from './config'
import type { LiveChatMessage__Output as LiveChatMessage } from './generated/youtube/api/v3/LiveChatMessage'
import type { LiveChatMessageListResponse__Output as ChatBatch } from './generated/youtube/api/v3/LiveChatMessageListResponse'
import type { V3DataLiveChatMessageServiceClient } from './generated/youtube/api/v3/V3DataLiveChatMessageService'

import { setTimeout } from 'node:timers/promises'

import { Metadata, status } from '@grpc/grpc-js'

class AiriUnavailableError extends Error {}

/**
 * Owns one live-chat connection and its AIRI transport for a single run.
 * State moves from idle to running, through bounded reconnects, and finally to closed.
 * Page tokens and accepted message IDs are process-local. Restarting starts a new history cutoff.
 */
export class LiveChatConnector {
  private started = false
  private readonly delivered = new Set<string>()

  constructor(
    private readonly config: ConnectorConfig,
    private readonly youtube: V3DataLiveChatMessageServiceClient,
    private readonly airi: Client,
  ) {}

  /**
   * Runs until the chat ends, retries are exhausted, or the signal aborts.
   * Cancels the active gRPC stream before closing both clients, including on startup failure.
   * A successful SDK send confirms transport acceptance only, not consumer processing.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (this.started)
      throw new Error('Connector already started')
    this.started = true

    // YouTube can send history across several initial responses. A timestamp cutoff skips that
    // history without dropping new messages that arrive in the first response or during reconnects.
    const startedAt = Date.now()
    const metadata = new Metadata()
    metadata.set('x-goog-api-key', this.config.apiKey)
    let pageToken: string | undefined
    let retries = 0

    try {
      while (!signal.aborted) {
        try {
          try {
            await this.airi.connect({ abortSignal: signal, timeout: 10_000 })
          }
          catch {
            // SDK errors can include the configured endpoint. Do not expose transport diagnostics
            // or credentials through connector errors. A failed connection does not advance the cursor.
            throw new AiriUnavailableError('AIRI connection unavailable')
          }
          if (signal.aborted)
            return

          const call = this.youtube.StreamList({
            liveChatId: this.config.liveChatId,
            part: ['id', 'snippet', 'authorDetails'],
            pageToken,
          }, metadata)
          const cancel = () => call.cancel()
          signal.addEventListener('abort', cancel, { once: true })
          let receivedBatch = false
          try {
            // Node's readable iterator applies backpressure. Do not create an unbounded event queue.
            const batches: AsyncIterable<ChatBatch> = call
            for await (const batch of batches) {
              if (signal.aborted)
                return

              for (const message of batch.items) {
                if (signal.aborted)
                  return
                if (message.snippet?.type === 'CHAT_ENDED_EVENT' && message.snippet.liveChatId === this.config.liveChatId)
                  return
                this.forward(message, startedAt)
              }

              if (batch.offlineAt)
                return
              if (!batch.nextPageToken)
                throw new Error('YouTube response lacks a resume token')

              // Commit only after every eligible message is accepted. If a later send fails,
              // replay from the prior token and suppress IDs already accepted in the partial batch.
              if (pageToken !== batch.nextPageToken)
                retries = 0
              pageToken = batch.nextPageToken
              receivedBatch = true
            }
          }
          finally {
            signal.removeEventListener('abort', cancel)
            call.cancel()
          }
          // YouTube completes healthy idle RPCs with an unchanged cursor. Resume them without
          // spending the failure budget. Delay even successful completion to avoid a tight loop.
          if (receivedBatch) {
            retries = 0
            await setTimeout(1_000, undefined, { signal })
            continue
          }
        }
        catch (error) {
          if (signal.aborted)
            return
          if (!(error instanceof AiriUnavailableError)) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined
            const retryable = code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED || code === status.RESOURCE_EXHAUSTED || code === status.INTERNAL
            if (!retryable)
              throw new Error(`YouTube stream failed (gRPC ${typeof code === 'number' ? code : 'unknown'})`)
          }
        }

        if (retries >= this.config.maxRetries)
          throw new Error('Connector retry limit reached')
        // Consecutive failures back off from one second to thirty seconds. Only cursor progress
        // resets the budget, so empty connections cannot retry forever at the minimum interval.
        const delay = Math.min(1_000 * 2 ** retries, 30_000)
        retries += 1
        await setTimeout(delay, undefined, { signal })
      }
    }
    catch (error) {
      if (!signal.aborted)
        throw error
    }
    finally {
      this.youtube.close()
      this.airi.close()
      this.delivered.clear()
    }
  }

  private forward(message: LiveChatMessage, startedAt: number) {
    const snippet = message.snippet
    // A connector owns exactly one chat. System, moderation, funding, and membership events
    // are not viewer text and must not trigger conversational replies in this first version.
    if (!message.id || snippet?.liveChatId !== this.config.liveChatId || snippet.type !== 'TEXT_MESSAGE_EVENT')
      return
    if (this.delivered.has(message.id))
      return

    const publishedAt = Date.parse(snippet.publishedAt)
    if (!this.config.includeHistory && (!Number.isFinite(publishedAt) || publishedAt < startedAt))
      return
    const text = snippet.textMessageDetails?.messageText
    if (!text?.trim())
      return

    // The channel ID remains useful when YouTube omits the display name. If both are absent,
    // explicitly attribute the text to an unknown viewer rather than the local user.
    const channelId = message.authorDetails?.channelId || snippet.authorChannelId || 'unknown'
    const displayName = message.authorDetails?.displayName || channelId
    const accepted = this.airi.send({
      type: 'input:text',
      metadata: { event: { id: `youtube:${this.config.liveChatId}:${message.id}` } },
      data: {
        text,
        textRaw: text,
        overrides: {
          // AIRI owns session creation. An omitted ID routes to its existing active chat.
          messagePrefix: `(YouTube viewer ${JSON.stringify(displayName)}): `,
        },
      },
    })
    if (!accepted)
      throw new AiriUnavailableError('AIRI transport rejected the message')

    this.delivered.add(message.id)
    // This is replay protection for recent messages, not durable exactly-once delivery.
    // The cap prevents an all-day stream from retaining every viewer message ID.
    if (this.delivered.size > 10_000) {
      const oldest = this.delivered.values().next().value
      if (oldest !== undefined)
        this.delivered.delete(oldest)
    }
  }
}
