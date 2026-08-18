import type { MotionManagerPluginContext, PixiLive2DInternalModel } from './motion-manager'

import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import {
  useMotionUpdatePluginAutoEyeBlink,
  useMotionUpdatePluginBodyTilt,
  useMotionUpdatePluginIdleDisable,
  useMotionUpdatePluginIdleMouseMotion,
} from './motion-manager'

vi.mock('./animation', () => ({
  useLive2DIdleEyeFocus: () => ({ update: vi.fn() }),
}))

function createModel(initialValues: Record<string, number> = {}) {
  const values = new Map(Object.entries(initialValues))
  return {
    getParameterValueById: vi.fn((id: string) => values.get(id) ?? 1),
    setParameterValueById: vi.fn((id: string, value: number) => {
      values.set(id, value)
    }),
    values,
  }
}

type TestMotionManagerPluginContext = MotionManagerPluginContext & {
  beforeModelUpdateListeners: Array<() => void>
}

function createContext(overrides: Partial<MotionManagerPluginContext> = {}): TestMotionManagerPluginContext {
  const model = createModel({
    ParamEyeLOpen: 1,
    ParamEyeROpen: 1,
  })
  const beforeModelUpdateListeners: Array<() => void> = []
  const context = {
    model,
    now: 1000,
    timeDelta: 16,
    internalModel: {
      eyeBlink: {
        updateParameters: vi.fn((targetModel: typeof model) => {
          targetModel.setParameterValueById('ParamEyeLOpen', 0.5)
          targetModel.setParameterValueById('ParamEyeROpen', 0.25)
        }),
      },
      coreModel: model,
      on: vi.fn((_event: string, listener: () => void) => {
        beforeModelUpdateListeners.push(listener)
      }),
    } as unknown as PixiLive2DInternalModel,
    beforeModelUpdateListeners,
    motionManager: {
      stopAllMotions: vi.fn(),
      state: { currentGroup: undefined },
      groups: { idle: 'Idle' },
    } as unknown as PixiLive2DInternalModel['motionManager'],
    modelParameters: ref({
      leftEyeOpen: 1,
      rightEyeOpen: 1,
      bodyAngleX: 1,
      bodyAngleY: 2,
      bodyAngleZ: 3,
    }),
    live2dEyeTrackingEnabled: ref(false),
    live2dEyeFocusSourceActive: ref(false),
    live2dIdleAnimationEnabled: ref(true),
    live2dForceIdleEyeAnimation: ref(false),
    live2dAutoBlinkEnabled: ref(true),
    live2dForceAutoBlinkEnabled: ref(false),
    isIdleMotion: true,
    handled: false as boolean,
    markHandled: vi.fn(() => {
      context.handled = true
    }),
  }

  return Object.assign(context, overrides) as unknown as TestMotionManagerPluginContext
}

describe('live2d motion manager plugins', () => {
  /**
   * @example
   * expect(idleEyeFocus.update).toHaveBeenCalled()
   */
  it('keeps idle eye focus alive when idle motion is disabled', () => {
    const idleEyeFocus = { update: vi.fn() }
    const context = createContext({
      live2dIdleAnimationEnabled: ref(false),
      live2dForceIdleEyeAnimation: ref(true),
    })

    useMotionUpdatePluginIdleDisable(idleEyeFocus)(context)

    expect(idleEyeFocus.update).toHaveBeenCalledWith(context.internalModel, context.now)
  })

  /**
   * @example
   * expect(idleEyeFocus.update).not.toHaveBeenCalled()
   */
  it('lets mouse tracking own focus while a tracking source is active', () => {
    const idleEyeFocus = { update: vi.fn() }
    const context = createContext({
      live2dEyeTrackingEnabled: ref(true),
      live2dEyeFocusSourceActive: ref(true),
      live2dIdleAnimationEnabled: ref(false),
      live2dForceIdleEyeAnimation: ref(true),
    })

    useMotionUpdatePluginIdleDisable(idleEyeFocus)(context)

    expect(idleEyeFocus.update).not.toHaveBeenCalled()
  })

  it('adds the mouse X offset to body tilt while tracking is active', () => {
    const context = createContext({
      modelParameters: ref({ bodyAngleX: 1, bodyAngleY: 2, bodyAngleZ: 3 }),
      live2dEyeTrackingEnabled: ref(true),
      live2dEyeFocusSourceActive: ref(true),
    })
    const mouseOffset = ref({ x: -10, y: 16 })
    const idleMouseOffset = ref({ x: 0, y: 0 })

    const plugin = useMotionUpdatePluginBodyTilt(mouseOffset, idleMouseOffset)
    plugin(context)
    context.beforeModelUpdateListeners.forEach(listener => listener())

    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamBodyAngleX', -4)
    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamBodyAngleY', 10)
    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamBodyAngleZ', -17)
  })

  it('restores the stored body tilt when tracking is inactive', () => {
    const context = createContext({
      modelParameters: ref({ bodyAngleX: 1, bodyAngleY: 2, bodyAngleZ: 3 }),
      live2dEyeTrackingEnabled: ref(true),
      live2dEyeFocusSourceActive: ref(true),
    })
    const mouseOffset = ref({ x: -10, y: 16 })
    const idleMouseOffset = ref({ x: 0, y: 0 })
    const plugin = useMotionUpdatePluginBodyTilt(mouseOffset, idleMouseOffset)

    plugin(context)
    context.live2dEyeFocusSourceActive.value = false
    plugin(context)
    context.beforeModelUpdateListeners.forEach(listener => listener())

    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamBodyAngleX', 1)
    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamBodyAngleY', 2)
    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamBodyAngleZ', 3)
  })

  it('reapplies body tilt after model physics overwrites body angles', () => {
    const context = createContext({
      modelParameters: ref({ bodyAngleX: 1, bodyAngleY: 2, bodyAngleZ: 3 }),
      live2dEyeTrackingEnabled: ref(true),
      live2dEyeFocusSourceActive: ref(true),
    })
    const mouseOffset = ref({ x: -10, y: 16 })
    const idleMouseOffset = ref({ x: 0, y: 0 })
    const plugin = useMotionUpdatePluginBodyTilt(mouseOffset, idleMouseOffset)

    plugin(context)
    context.model.setParameterValueById('ParamBodyAngleX', 0)
    context.model.setParameterValueById('ParamBodyAngleY', 0)
    context.model.setParameterValueById('ParamBodyAngleZ', 0)
    context.beforeModelUpdateListeners.forEach(listener => listener())

    expect(context.model.setParameterValueById).toHaveBeenLastCalledWith('ParamBodyAngleZ', -17)
  })

  it('updates procedural mouse motion during idle tracking', () => {
    const context = createContext({
      live2dForceIdleEyeAnimation: ref(true),
      live2dEyeTrackingEnabled: ref(false),
    })
    const idleMouseMotion = {
      offset: ref({ x: 0, y: 0 }),
      direction: ref({ x: 0, y: 0 }),
      update: vi.fn(),
      reset: vi.fn(),
    }

    useMotionUpdatePluginIdleMouseMotion(idleMouseMotion, ref({ x: 0, y: 0 }))(context)

    expect(idleMouseMotion.update).toHaveBeenCalledWith(context.now, context.timeDelta)
    expect(idleMouseMotion.reset).not.toHaveBeenCalled()
  })

  it('resets procedural mouse motion when external tracking is active', () => {
    const context = createContext({
      live2dForceIdleEyeAnimation: ref(true),
      live2dEyeTrackingEnabled: ref(true),
      live2dEyeFocusSourceActive: ref(true),
    })
    const idleMouseMotion = {
      offset: ref({ x: 0, y: 0 }),
      direction: ref({ x: 0, y: 0 }),
      update: vi.fn(),
      reset: vi.fn(),
    }

    useMotionUpdatePluginIdleMouseMotion(idleMouseMotion, ref({ x: -10, y: 16 }))(context)

    expect(idleMouseMotion.reset).toHaveBeenCalled()
    expect(idleMouseMotion.reset).toHaveBeenCalledWith({ x: -10, y: 16 })
    expect(idleMouseMotion.update).not.toHaveBeenCalled()
  })

  /**
   * @example
   * expect(context.internalModel.eyeBlink?.updateParameters).toHaveBeenCalled()
   */
  it('uses the model built-in blink when auto blink is enabled and force blink is disabled', () => {
    const context = createContext({
      live2dAutoBlinkEnabled: ref(true),
      live2dForceAutoBlinkEnabled: ref(false),
    })

    useMotionUpdatePluginAutoEyeBlink(ref(false))(context)

    expect(context.internalModel.eyeBlink?.updateParameters).toHaveBeenCalled()
    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamEyeLOpen', 0.5)
    expect(context.model.setParameterValueById).toHaveBeenCalledWith('ParamEyeROpen', 0.25)
    expect(context.handled).toBe(true)
  })

  /**
   * @example
   * expect(context.internalModel.eyeBlink?.updateParameters).not.toHaveBeenCalled()
   */
  it('does not call the model built-in blink when force blink is enabled', () => {
    const context = createContext({
      live2dAutoBlinkEnabled: ref(true),
      live2dForceAutoBlinkEnabled: ref(true),
      timeDelta: 4000,
    })

    useMotionUpdatePluginAutoEyeBlink(ref(false))(context)

    expect(context.internalModel.eyeBlink?.updateParameters).not.toHaveBeenCalled()
    expect(context.handled).toBe(true)
  })

  /**
   * @example
   * expect(context.model.getParameterValueById('ParamEyeLOpen')).toBeLessThan(1)
   */
  it('opens force blink over a randomized 150ms to 300ms duration', () => {
    const randomSpy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)

    const context = createContext({
      live2dAutoBlinkEnabled: ref(true),
      live2dForceAutoBlinkEnabled: ref(true),
      timeDelta: 3,
    })
    const plugin = useMotionUpdatePluginAutoEyeBlink(ref(false))

    // ROOT CAUSE:
    //
    // Force blink previously reopened at one fixed speed.
    // That made closed eyes feel either too quick or too slow depending on
    // the model's eye-open parameter range.
    //
    // We fixed this by randomizing each opening phase between 150ms and 300ms.
    plugin(context)
    context.timeDelta = 0.075
    context.handled = false
    plugin(context)
    context.timeDelta = 0.15
    context.handled = false
    plugin(context)

    expect(context.model.getParameterValueById('ParamEyeLOpen')).toBeCloseTo(4 / 9)
    expect(context.model.getParameterValueById('ParamEyeROpen')).toBeCloseTo(4 / 9)

    context.timeDelta = 0.075
    context.handled = false
    plugin(context)

    expect(context.model.getParameterValueById('ParamEyeLOpen')).toBe(1)
    expect(context.model.getParameterValueById('ParamEyeROpen')).toBe(1)

    randomSpy.mockRestore()
  })
})
