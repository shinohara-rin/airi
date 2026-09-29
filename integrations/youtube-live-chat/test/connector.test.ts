import type { LiveChatMessage } from '../src/generated/youtube/api/v3/LiveChatMessage'
import type { LiveChatMessageListResponse } from '../src/generated/youtube/api/v3/LiveChatMessageListResponse'
import type { V3DataLiveChatMessageServiceHandlers } from '../src/generated/youtube/api/v3/V3DataLiveChatMessageService'

import { status } from '@grpc/grpc-js'
import { Client } from '@proj-airi/server-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readConfig } from '../src/config'
import { LiveChatConnector } from '../src/connector'
import { createYouTubeClient } from '../src/youtube'
import { openChatServer } from './fixtures'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
})

function message(id: string, publishedAt = new Date(Date.now() + 1_000).toISOString()): LiveChatMessage {
  return {
    id,
    snippet: { type: 'TEXT_MESSAGE_EVENT', liveChatId: 'chat', publishedAt, textMessageDetails: { messageText: `hello ${id}` } },
    authorDetails: { displayName: 'Viewer', channelId: 'viewer-channel' },
  }
}

async function fixture(handler: V3DataLiveChatMessageServiceHandlers['StreamList'], env: Record<string, string> = {}) {
  const server = await openChatServer(handler)
  const youtube = createYouTubeClient(server.address, false)
  const airi = new Client({ name: 'youtube-test', autoConnect: false })
  const connect = vi.spyOn(airi, 'connect').mockResolvedValue()
  const send = vi.spyOn(airi, 'send').mockReturnValue(true)
  const close = vi.spyOn(airi, 'close')
  const youtubeClose = vi.spyOn(youtube, 'close')
  cleanups.push(server.close, () => youtube.close(), () => airi.close())
  const config = readConfig({ YOUTUBE_LIVE_CHAT_ID: 'chat', YOUTUBE_API_KEY: 'test-key', ...env })
  const connector = new LiveChatConnector(config, youtube, airi)
  return { connector, connect, send, close, youtubeClose }
}

describe('youTube to AIRI connector', () => {
  it('uses authenticated StreamList and forwards text with viewer and session identity', async () => {
    const calls: string[] = []
    const fixtureResult = await fixture((call) => {
      expect(call.metadata.get('x-goog-api-key')).toEqual(['test-key'])
      expect(call.request.liveChatId).toBe('chat')
      expect(call.request.part).toEqual(['id', 'snippet', 'authorDetails'])
      calls.push('youtube')
      call.write({ items: [message('one')], offlineAt: 'ended' } satisfies LiveChatMessageListResponse)
      call.end()
    })
    fixtureResult.connect.mockImplementation(async () => {
      calls.push('airi')
    })
    await fixtureResult.connector.run(new AbortController().signal)
    expect(calls).toEqual(['airi', 'youtube'])
    expect(fixtureResult.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'input:text',
      data: {
        text: 'hello one',
        textRaw: 'hello one',
        overrides: { sessionId: 'youtube:chat', messagePrefix: '(YouTube viewer "Viewer", channel viewer-channel): ' },
      },
      metadata: { event: { id: 'youtube:chat:one' } },
    }))
    expect(fixtureResult.close).toHaveBeenCalledOnce()
    expect(fixtureResult.youtubeClose).toHaveBeenCalledOnce()
  })

  it('skips history, malformed messages, other chats, and non-text events across batches', async () => {
    const invalid = message('invalid', 'not-a-date')
    const otherChat = message('other')
    otherChat.snippet = { ...otherChat.snippet, liveChatId: 'another-chat' }
    const member = message('member')
    member.snippet = { ...member.snippet, type: 'NEW_SPONSOR_EVENT' }
    const f = await fixture((call) => {
      call.write({ items: [message('old', '2000-01-01T00:00:00Z')], nextPageToken: 'history-1' })
      call.write({ items: [message('older', '2000-01-01T00:00:00Z'), invalid, otherChat, member, message('live'), message('live')], offlineAt: 'ended' })
      call.end()
    })
    await f.connector.run(new AbortController().signal)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][0].data).toHaveProperty('text', 'hello live')
  })

  it('includes history only when explicitly enabled', async () => {
    const f = await fixture((call) => {
      call.write({ items: [message('old', '2000-01-01T00:00:00Z')], offlineAt: 'ended' })
      call.end()
    }, { YOUTUBE_INCLUDE_HISTORY: 'true' })
    await f.connector.run(new AbortController().signal)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('resumes the last accepted batch and does not repeat a partially delivered batch', async () => {
    const pageTokens: string[] = []
    const f = await fixture((call) => {
      pageTokens.push(call.request.pageToken)
      if (pageTokens.length === 1) {
        call.write({ items: [message('one')], nextPageToken: 'accepted' })
        call.write({ items: [message('two'), message('three')], nextPageToken: 'not-yet-accepted' })
      }
      else {
        call.write({ items: [message('two'), message('three')], nextPageToken: 'done', offlineAt: 'ended' })
      }
      call.end()
    })
    f.send.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true)
    await f.connector.run(new AbortController().signal)
    expect(pageTokens).toEqual(['', 'accepted'])
    expect(f.send.mock.calls.map(([event]) => event.metadata?.event?.id)).toEqual(['youtube:chat:one', 'youtube:chat:two', 'youtube:chat:three', 'youtube:chat:three'])
  })

  it('retries transient errors with the last page token', async () => {
    const tokens: string[] = []
    const f = await fixture((call) => {
      tokens.push(call.request.pageToken)
      if (tokens.length === 1) {
        call.write({ items: [message('one')], nextPageToken: 'resume' })
        // Wait for the message to reach the connector before ending the RPC with an error.
        void vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1)).then(() => {
          call.emit('error', Object.assign(new Error('unavailable'), { code: status.UNAVAILABLE }))
        })
      }
      else {
        call.write({ items: [message('one'), message('two')], offlineAt: 'ended' })
        call.end()
      }
    })
    await f.connector.run(new AbortController().signal)
    expect(tokens).toEqual(['', 'resume'])
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it('stops on permission errors without disclosing server details', async () => {
    const handler = vi.fn<V3DataLiveChatMessageServiceHandlers['StreamList']>((call) => {
      call.emit('error', Object.assign(new Error('sensitive upstream details'), { code: status.PERMISSION_DENIED }))
    })
    const f = await fixture(handler)
    const run = f.connector.run(new AbortController().signal)
    await expect(run).rejects.toThrow('YouTube stream failed (gRPC 7)')
    await expect(run).rejects.not.toThrow('sensitive upstream details')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalledOnce()
  })

  it('bounds retries even when the stream closes without progress', async () => {
    const handler = vi.fn<V3DataLiveChatMessageServiceHandlers['StreamList']>(call => call.end())
    const f = await fixture(handler, { YOUTUBE_MAX_RETRIES: '1' })
    await expect(f.connector.run(new AbortController().signal)).rejects.toThrow('retry limit')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('cancels an idle stream and closes both clients on shutdown', async () => {
    const controller = new AbortController()
    const cancelled = vi.fn()
    const f = await fixture((call) => {
      call.on('cancelled', cancelled)
      controller.abort()
    })
    await f.connector.run(controller.signal)
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
    expect(f.send).not.toHaveBeenCalled()
    expect(f.youtubeClose).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledOnce()
    await expect(f.connector.run(controller.signal)).rejects.toThrow('already started')
  })

  it('cancels a retry wait without opening another stream', async () => {
    const controller = new AbortController()
    const f = await fixture(call => call.end())
    const run = f.connector.run(controller.signal)
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce())
    controller.abort()
    await run
    expect(f.connect).toHaveBeenCalledOnce()
  })

  it.each([status.INVALID_ARGUMENT, status.NOT_FOUND, status.FAILED_PRECONDITION, status.UNAUTHENTICATED])('does not retry terminal gRPC status %s', async (code) => {
    const handler = vi.fn<V3DataLiveChatMessageServiceHandlers['StreamList']>((call) => {
      call.emit('error', Object.assign(new Error('terminal failure'), { code }))
    })
    const f = await fixture(handler)
    await expect(f.connector.run(new AbortController().signal)).rejects.toThrow(`gRPC ${code}`)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('closes both clients when AIRI cannot connect and does not read YouTube', async () => {
    const handler = vi.fn<V3DataLiveChatMessageServiceHandlers['StreamList']>(call => call.end())
    const f = await fixture(handler, { YOUTUBE_MAX_RETRIES: '0' })
    f.connect.mockRejectedValue(new Error('secret endpoint diagnostic'))
    await expect(f.connector.run(new AbortController().signal)).rejects.toThrow('retry limit')
    expect(handler).not.toHaveBeenCalled()
    expect(f.youtubeClose).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it('stops on a chat-ended event without forwarding later messages', async () => {
    const f = await fixture((call) => {
      call.write({ items: [{ snippet: { type: 'CHAT_ENDED_EVENT', liveChatId: 'chat' } }, message('late')] })
      call.end()
    })
    await f.connector.run(new AbortController().signal)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('retains only the most recent ten thousand accepted message IDs', async () => {
    const f = await fixture((call) => {
      call.write({ items: Array.from({ length: 10_001 }, (_, index) => message(`${index}`)), nextPageToken: 'many' })
      call.write({ items: [message('10000'), message('0')], offlineAt: 'ended' })
      call.end()
    })
    await f.connector.run(new AbortController().signal)
    expect(f.send).toHaveBeenCalledTimes(10_002)
    expect(f.send.mock.lastCall?.[0].metadata?.event?.id).toBe('youtube:chat:0')
  })
})
