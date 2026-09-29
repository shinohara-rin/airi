import type { WebSocketEventOf } from '@proj-airi/server-sdk'

import type { V3DataLiveChatMessageServiceHandlers } from '../src/generated/youtube/api/v3/V3DataLiveChatMessageService'

import { createServer as createTcpServer } from 'node:net'

import { createServer } from '@proj-airi/server-runtime/server'
import { Client } from '@proj-airi/server-sdk'
import { MessageHeartbeat, MessageHeartbeatKind } from '@proj-airi/server-shared/types'
import { expect, it, vi } from 'vitest'

import { readConfig } from '../src/config'
import { LiveChatConnector } from '../src/connector'
import { createYouTubeClient } from '../src/youtube'
import { openChatServer } from './fixtures'

it('delivers one decoded YouTube message through authenticated AIRI SDK and runtime routing', async ({ onTestFinished }) => {
  // The runtime wrapper does not expose its bound port. Obtain an ephemeral loopback port
  // first, then start the real runtime. A connection failure fails the test instead of using a mock.
  const probe = createTcpServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  const runtime = createServer({ hostname: '127.0.0.1', port: address.port, auth: { token: 'wire-test-token' } })
  onTestFinished(() => runtime.stop())
  await runtime.start()

  const url = `ws://127.0.0.1:${address.port}/ws`
  const consumer = new Client({ name: 'youtube-test-stage', url, token: 'wire-test-token', autoConnect: false })
  onTestFinished(() => consumer.close())
  const received: WebSocketEventOf<'input:text'>[] = []
  consumer.onEvent('input:text', (event) => {
    received.push(event)
  })
  await consumer.connect()
  consumer.sendOrThrow({ type: 'module:consumer:register', data: { event: 'input:text', mode: 'consumer-group', group: 'chat-ingestion' } })

  // WebSocket frames are ordered. A pong after registration proves the server processed it
  // before the producer starts, without a timing-dependent sleep.
  const registered = new Promise<void>((resolve) => {
    consumer.onEvent('transport:connection:heartbeat', (event) => {
      if (event.data.kind === MessageHeartbeatKind.Pong)
        resolve()
    })
  })
  consumer.sendOrThrow({ type: 'transport:connection:heartbeat', data: { kind: MessageHeartbeatKind.Ping, message: MessageHeartbeat.Ping, at: Date.now() } })
  await registered

  const handler: V3DataLiveChatMessageServiceHandlers['StreamList'] = (call) => {
    call.write({
      items: [{
        id: 'wire-message',
        snippet: {
          type: 'TEXT_MESSAGE_EVENT',
          liveChatId: 'wire-chat',
          publishedAt: new Date(Date.now() + 1_000).toISOString(),
          textMessageDetails: { messageText: 'Hello AIRI 👋' },
        },
        authorDetails: { channelId: 'viewer-id', displayName: 'Viewer' },
      }],
      offlineAt: 'ended',
    })
    call.end()
  }
  const youtubeServer = await openChatServer(handler)
  onTestFinished(youtubeServer.close)
  const youtube = createYouTubeClient(youtubeServer.address, false)
  onTestFinished(() => youtube.close())
  const sender = new Client({ name: 'youtube-live-chat', url, token: 'wire-test-token', autoConnect: false })
  onTestFinished(() => sender.close())
  const config = readConfig({ YOUTUBE_LIVE_CHAT_ID: 'wire-chat', YOUTUBE_API_KEY: 'fixture-key' })
  await new LiveChatConnector(config, youtube, sender).run(new AbortController().signal)

  await vi.waitFor(() => expect(received).toHaveLength(1))
  expect(received[0].data.text).toBe('Hello AIRI 👋')
  expect(received[0].data.textRaw).toBe('Hello AIRI 👋')
  expect(received[0].data.overrides?.sessionId).toBe('youtube:wire-chat')
  expect(received[0].data.overrides?.messagePrefix).toContain('Viewer')
  expect(received[0].metadata?.event?.id).toBe('youtube:wire-chat:wire-message')
})
