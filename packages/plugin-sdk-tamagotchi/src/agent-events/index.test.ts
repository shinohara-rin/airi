import type { KitClientRuntime } from '@proj-airi/plugin-sdk'

import type { AgentEventsKitRuntime } from './index'

import { DisposableStore } from '@proj-airi/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'

import { agentEventsKit } from './index'

function createRuntime(push?: NonNullable<AgentEventsKitRuntime['agentEvents']>['push']): KitClientRuntime & AgentEventsKitRuntime {
  return {
    extensionId: 'game-plugin',
    sessionId: 'session-1',
    subscriptions: new DisposableStore(),
    ...(push ? { agentEvents: { push } } : {}),
  }
}

describe('agentEventsKit', () => {
  it('hands a valid event to the host', async () => {
    const push = vi.fn()
    const client = agentEventsKit.createClient(createRuntime(push))

    await client.push({ type: 'game.job_finished', text: 'the mining job finished', trigger: 'flush', meta: { jobId: 1 } })

    expect(push).toHaveBeenCalledWith({ type: 'game.job_finished', text: 'the mining job finished', trigger: 'flush', meta: { jobId: 1 } })
  })

  it.each([
    ['an empty text', { type: 'a', text: '' }],
    ['a text over the limit', { type: 'a', text: 'x'.repeat(4001) }],
    ['a type with spaces', { type: 'a b', text: 'hi' }],
    ['an unknown trigger', { type: 'a', text: 'hi', trigger: 'now' }],
    ['an image that is not an image data URL', { type: 'a', text: 'hi', images: ['https://example.com/a.png'] }],
    ['too many images', { type: 'a', text: 'hi', images: Array.from({ length: 5 }).fill('data:image/png;base64,AA') }],
  ])('rejects %s and does not reach the host', async (_name, event) => {
    const push = vi.fn()
    const client = agentEventsKit.createClient(createRuntime(push))

    await expect(client.push(event as Parameters<typeof client.push>[0])).rejects.toThrow()

    expect(push).not.toHaveBeenCalled()
  })

  it('fails when the host provides no agent event runtime', async () => {
    const client = agentEventsKit.createClient(createRuntime())

    await expect(client.push({ type: 'a', text: 'hi' })).rejects.toThrow('agentEventsKit requires a host agent event runtime.')
  })
})
