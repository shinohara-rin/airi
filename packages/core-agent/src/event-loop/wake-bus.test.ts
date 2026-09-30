import type { AgentEvent, WakeBusOptions } from './types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WakeBus } from './wake-bus'

const options: WakeBusOptions = { quietGapMs: 100, minBatchAgeMs: 20, maxBatchAgeMs: 500, maxBatchSize: 3 }

function event(text: string, origin: AgentEvent['origin'] = 'external'): AgentEvent {
  return { id: text, type: 'test', source: 'test', origin, ts: 0, text }
}

function texts(batch: AgentEvent[]) {
  return batch.map(item => item.text)
}

describe('wakeBus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers a flush event at once together with queued piggyback events', async () => {
    const bus = new WakeBus(options)
    bus.push(event('a'), { trigger: 'piggyback' })
    const batch = bus.nextBatch()
    bus.push(event('b'), { trigger: 'flush' })

    expect(texts(await batch)).toEqual(['a', 'b'])
  })

  it('does not deliver piggyback events alone', async () => {
    const bus = new WakeBus(options)
    const delivered = vi.fn()
    void bus.nextBatch().then(delivered)

    bus.push(event('a'), { trigger: 'piggyback' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(delivered).not.toHaveBeenCalled()
  })

  it('delivers a debounce batch after the quiet gap', async () => {
    const bus = new WakeBus(options)
    const delivered = vi.fn()
    void bus.nextBatch().then(delivered)

    bus.push(event('a'))
    await vi.advanceTimersByTimeAsync(60)
    bus.push(event('b'))
    await vi.advanceTimersByTimeAsync(90)
    expect(delivered).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(20)
    expect(texts(delivered.mock.calls[0][0])).toEqual(['a', 'b'])
  })

  it('delivers at the maximum age even while events keep arriving', async () => {
    const bus = new WakeBus({ ...options, maxBatchSize: 100 })
    const delivered = vi.fn()
    void bus.nextBatch().then(delivered)

    for (let index = 0; index < 10; index++) {
      bus.push(event(String(index)))
      await vi.advanceTimersByTimeAsync(80)
    }

    expect(delivered).toHaveBeenCalledTimes(1)
  })

  it('delivers when the batch size is reached', async () => {
    const bus = new WakeBus(options)
    const batch = bus.nextBatch()

    bus.push(event('a'))
    bus.push(event('b'))
    bus.push(event('c'))

    expect(texts(await batch)).toEqual(['a', 'b', 'c'])
  })

  it('hands a batch to a consumer that arrives late', async () => {
    const bus = new WakeBus(options)
    bus.push(event('a'), { trigger: 'flush' })

    expect(texts(await bus.nextBatch())).toEqual(['a'])
  })

  it('defaults internal events to flush and external events to debounce', async () => {
    const bus = new WakeBus(options)
    const delivered = vi.fn()
    void bus.nextBatch().then(delivered)

    bus.push(event('external'))
    expect(delivered).not.toHaveBeenCalled()
    bus.push(event('internal', 'internal'))
    await Promise.resolve()

    expect(texts(delivered.mock.calls[0][0])).toEqual(['external', 'internal'])
  })

  it('reports a preempt event to the handler after delivering', async () => {
    const bus = new WakeBus(options)
    const handler = vi.fn()
    bus.setPreemptHandler(handler)

    bus.push(event('a'), { trigger: 'preempt' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(texts(await bus.nextBatch())).toEqual(['a'])
  })

  it('holds delivery while paused and delivers the backlog on resume', async () => {
    const bus = new WakeBus(options)
    const delivered = vi.fn()
    void bus.nextBatch().then(delivered)
    bus.setPaused(true)

    bus.push(event('a'), { trigger: 'flush' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(delivered).not.toHaveBeenCalled()

    bus.setPaused(false)
    await Promise.resolve()
    expect(texts(delivered.mock.calls[0][0])).toEqual(['a'])
  })

  it('puts requeued events in front of newer ones', async () => {
    const bus = new WakeBus(options)
    bus.push(event('new'), { trigger: 'piggyback' })
    bus.requeue([event('old')])

    expect(texts(await bus.nextBatch())).toEqual(['old', 'new'])
  })
})
