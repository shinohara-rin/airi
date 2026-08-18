import type { InternalModel } from 'pixi-live2d-display/cubism4'

import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { useLive2DIdleEyeFocus } from './animation'

vi.mock('../../utils', () => ({
  randomSaccadeInterval: () => 1000,
}))

describe('useLive2DIdleEyeFocus', () => {
  it('uses the shared idle direction for eye focus', () => {
    const values = new Map([
      ['ParamEyeBallX', 0],
      ['ParamEyeBallY', 0],
    ])
    const model = {
      coreModel: {
        getParameterValueById: (id: string) => values.get(id) ?? 0,
        setParameterValueById: (id: string, value: number) => values.set(id, value),
      },
      focusController: {
        focus: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as InternalModel
    const direction = ref({ x: 0.4, y: -0.2 })
    const idleEyeFocus = useLive2DIdleEyeFocus(direction)

    idleEyeFocus.update(model, 1)

    expect(model.focusController.focus).toHaveBeenCalledWith(0.2, -0.1, false)
    expect(values.get('ParamEyeBallX')).toBe(0.12)
    expect(values.get('ParamEyeBallY')).toBe(-0.06)

    direction.value = { x: 0.5, y: -0.1 }
    idleEyeFocus.update(model, 1.016)

    expect(model.focusController.focus).toHaveBeenLastCalledWith(0.25, -0.05, false)
    expect(model.focusController.update).not.toHaveBeenCalled()
  })
})
