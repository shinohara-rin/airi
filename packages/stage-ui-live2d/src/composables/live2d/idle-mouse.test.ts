import { describe, expect, it, vi } from 'vitest'

import { createLive2DIdleMouseMotion, mapLive2DMouseDisplacementToModelOffset } from './idle-mouse'

describe('live2d idle mouse motion', () => {
  it('uses the same model offset mapping as real mouse tracking', () => {
    expect(mapLive2DMouseDisplacementToModelOffset(
      { x: 1, y: 0.5 },
      { width: 1000, height: 800 },
    )).toEqual({ x: -20, y: 16 })
  })

  it('moves continuously without jumping to fixed points', () => {
    const idleMotion = createLive2DIdleMouseMotion(
      { width: 1000, height: 800 },
      { random: vi.fn(() => 0.5) },
    )

    const offsets: number[] = []
    for (let frame = 1; frame <= 10; frame++) {
      idleMotion.update(frame * 0.016, 0.016)
      offsets.push(idleMotion.offset.value.x)
    }

    expect(new Set(offsets).size).toBeGreaterThan(1)
    expect(Math.max(...offsets)).toBeLessThan(12)
    expect(Math.min(...offsets)).toBeGreaterThan(-12)
  })

  it('returns to neutral when reset', () => {
    const idleMotion = createLive2DIdleMouseMotion(
      { width: 1000, height: 800 },
      { random: vi.fn(() => 0.5) },
    )

    idleMotion.update(0, 0.016)
    idleMotion.reset()

    expect(idleMotion.offset.value).toEqual({ x: 0, y: 0 })
  })

  it('seeds the next idle motion from the last mouse offset', () => {
    const idleMotion = createLive2DIdleMouseMotion(
      { width: 1000, height: 800 },
      { random: vi.fn(() => 0.5) },
    )

    idleMotion.reset({ x: -20, y: 16 })
    idleMotion.update(0, 0.016)

    expect(idleMotion.offset.value.x).toBeLessThan(-12)
  })
})
