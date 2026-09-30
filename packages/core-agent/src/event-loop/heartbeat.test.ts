import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Heartbeat } from './heartbeat'

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('doubles the interval for each quiet beat up to eight times the base', async () => {
    const onBeat = vi.fn()
    const heartbeat = new Heartbeat(() => 1000, onBeat)
    heartbeat.start()

    const beatTimes: number[] = []
    onBeat.mockImplementation(() => beatTimes.push(Date.now()))
    const startedAt = Date.now()
    await vi.advanceTimersByTimeAsync(60_000)
    heartbeat.stop()

    const gaps = beatTimes.map((time, index) => time - (index === 0 ? startedAt : beatTimes[index - 1]))
    expect(gaps.slice(0, 6)).toEqual([1000, 1000, 2000, 4000, 8000, 8000])
  })

  it('returns to the base interval after activity', async () => {
    const onBeat = vi.fn()
    const heartbeat = new Heartbeat(() => 1000, onBeat)
    heartbeat.start()
    await vi.advanceTimersByTimeAsync(1000 + 1000 + 2000)
    expect(onBeat).toHaveBeenCalledTimes(3)

    // The pending 4 second timer still fires. It counts as an active beat, so the gap after it is the base.
    await vi.advanceTimersByTimeAsync(1)
    heartbeat.noteActivity()
    await vi.advanceTimersByTimeAsync(3999)
    expect(onBeat).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(1000)
    expect(onBeat).toHaveBeenCalledTimes(5)
    heartbeat.stop()
  })

  it('reports the quiet time in seconds', async () => {
    const onBeat = vi.fn()
    const heartbeat = new Heartbeat(() => 5000, onBeat)
    heartbeat.start()

    await vi.advanceTimersByTimeAsync(5000)

    expect(onBeat).toHaveBeenCalledWith(5)
    heartbeat.stop()
  })

  it('does not beat while the base interval is missing', async () => {
    const onBeat = vi.fn()
    const heartbeat = new Heartbeat(() => undefined, onBeat)
    heartbeat.start()

    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(onBeat).not.toHaveBeenCalled()
    heartbeat.stop()
  })
})
