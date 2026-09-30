import type { KitClientRuntime } from '@proj-airi/plugin-sdk'

import { DisposableStore } from '@proj-airi/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'

import { AgentEventSink, createHostAgentEventsKit } from './agent-events'

function createRuntime(extensionId: string): KitClientRuntime {
  return { extensionId, sessionId: 'session-1', subscriptions: new DisposableStore() }
}

describe('agent events host kit', () => {
  it('names the extension as the source of the event', async () => {
    const sink = new AgentEventSink()
    const listener = vi.fn()
    sink.subscribe(listener)
    const client = createHostAgentEventsKit({ sink }).createClient(createRuntime('airicraft'))

    await client.push({ type: 'game.job_finished', text: 'the job finished', trigger: 'flush' })

    expect(listener).toHaveBeenCalledWith({
      source: 'airicraft',
      type: 'game.job_finished',
      text: 'the job finished',
      trigger: 'flush',
      images: undefined,
      meta: undefined,
    })
  })

  it('does not deliver an invalid event', async () => {
    const sink = new AgentEventSink()
    const listener = vi.fn()
    sink.subscribe(listener)
    const client = createHostAgentEventsKit({ sink }).createClient(createRuntime('airicraft'))

    await expect(client.push({ type: 'bad type', text: 'hi' })).rejects.toThrow()

    expect(listener).not.toHaveBeenCalled()
  })

  it('drops events with no subscriber and stops delivering after unsubscribe or clear', () => {
    const sink = new AgentEventSink()
    const first = vi.fn()
    const second = vi.fn()
    const event = { source: 'a', type: 't', text: 'x' }

    sink.emit(event)
    const unsubscribe = sink.subscribe(first)
    sink.subscribe(second)
    sink.emit(event)
    unsubscribe()
    sink.emit(event)
    sink.clear()
    sink.emit(event)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})
