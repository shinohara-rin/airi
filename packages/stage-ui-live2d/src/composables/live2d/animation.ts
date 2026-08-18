import type { InternalModel } from 'pixi-live2d-display/cubism4'
import type { Ref } from 'vue'

import type { Live2DLookDirection } from './idle-mouse'

import { MathUtils } from 'three'

import { randomSaccadeInterval } from '../../utils'

/**
 * Simulates idle eye saccades and focus (head) movements. When a direction is
 * provided, it follows the shared smoothed idle movement target.
 */
export function useLive2DIdleEyeFocus(direction?: Readonly<Ref<Live2DLookDirection>>) {
  let nextSaccadeAfter = -1
  let focusTarget: [number, number] | undefined
  let lastSaccadeAt = -1

  // Function to handle idle eye saccades and focus (head) movements
  function update(model: InternalModel, now: number) {
    if (direction) {
      const nextDirection = direction.value
      const nextFocusTarget: [number, number] = [nextDirection.x, nextDirection.y]
      if (focusTarget?.[0] !== nextFocusTarget[0] || focusTarget?.[1] !== nextFocusTarget[1]) {
        focusTarget = nextFocusTarget
        lastSaccadeAt = now
        model.focusController.focus(focusTarget[0] * 0.5, focusTarget[1] * 0.5, false)
      }
    }
    else if (now >= nextSaccadeAfter || now < lastSaccadeAt) {
      focusTarget = [MathUtils.randFloat(-1, 1), MathUtils.randFloat(-1, 0.7)]
      lastSaccadeAt = now
      nextSaccadeAfter = now + (randomSaccadeInterval() / 1000)
      model.focusController.focus(focusTarget[0] * 0.5, focusTarget[1] * 0.5, false)
    }

    // NOTICE:
    // InternalModel.update already advances focusController with millisecond dt before motion plugins run.
    // This plugin only sets the target; advancing it here would double-update it with second-based time.
    const coreModel = model.coreModel as any
    // TODO: After emotion mapper, stage editor, eye related parameters should be take cared to be dynamical instead of hardcoding
    coreModel.setParameterValueById('ParamEyeBallX', MathUtils.lerp(coreModel.getParameterValueById('ParamEyeBallX'), focusTarget![0], 0.3))
    coreModel.setParameterValueById('ParamEyeBallY', MathUtils.lerp(coreModel.getParameterValueById('ParamEyeBallY'), focusTarget![1], 0.3))
  }

  return { update }
}
