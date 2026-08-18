import type { MaybeRefOrGetter, Ref } from 'vue'

import { shallowRef, toValue } from 'vue'

export interface Live2DModelMouseOffset {
  x: number
  y: number
}

/** Normalized direction shared by idle model movement and eye focus. */
export interface Live2DLookDirection {
  x: number
  y: number
}

interface Live2DModelSize {
  width: number
  height: number
}

export interface Live2DIdleMotionAxisSettings {
  primaryRate: number
  detailRate: number
  chaosRate: number
  primaryAmplitude: number
  detailAmplitude: number
  chaosAmplitude: number
}

export interface Live2DIdleMotionTuning {
  speedRate: number
  speedVariation: number
  springStiffness: number
  springDamping: number
  x: Live2DIdleMotionAxisSettings
  y: Live2DIdleMotionAxisSettings
}

export interface Live2DIdleMotionSettings extends Live2DIdleMotionTuning {
  frequency: number
}

export const defaultLive2DIdleMotionTuning: Live2DIdleMotionTuning = {
  speedRate: 0.23,
  speedVariation: 1,
  springStiffness: 28,
  springDamping: 10.5,
  x: {
    primaryRate: 0.65,
    detailRate: 1.17,
    chaosRate: 2.31,
    primaryAmplitude: 0.55,
    detailAmplitude: 0.18,
    chaosAmplitude: 0.1,
  },
  y: {
    primaryRate: 0.52,
    detailRate: 0.91,
    chaosRate: 1.83,
    primaryAmplitude: 0.5,
    detailAmplitude: 0.2,
    chaosAmplitude: 0.12,
  },
}

export const defaultLive2DIdleMotionSettings: Live2DIdleMotionSettings = {
  frequency: 1,
  ...defaultLive2DIdleMotionTuning,
}

export interface Live2DIdleMouseMotion {
  offset: Readonly<Ref<Live2DModelMouseOffset>>
  /** The current smoothed look direction before model-size conversion. */
  direction: Readonly<Ref<Live2DLookDirection>>
  update: (now: number, timeDelta: number) => void
  reset: (offset?: Live2DModelMouseOffset) => void
}

export interface Live2DIdleMouseMotionOptions {
  settings?: MaybeRefOrGetter<Live2DIdleMotionSettings>
  random?: () => number
}

/**
 * Maps normalized cursor displacement to the same model offset as real mouse tracking.
 *
 * @example
 * mapLive2DMouseDisplacementToModelOffset({ x: 1, y: 0 }, { width: 1000, height: 800 })
 * // => { x: -20, y: 0 }
 */
export function mapLive2DMouseDisplacementToModelOffset(
  displacement: Live2DModelMouseOffset,
  modelSize: Live2DModelSize,
): Live2DModelMouseOffset {
  const x = -displacement.x * modelSize.width * 0.02

  return {
    x: x === 0 ? 0 : x,
    y: displacement.y * modelSize.height * 0.04,
  }
}

function getWanderAxis(
  time: number,
  frequency: number,
  phase: number,
  detailPhase: number,
  chaosPhase: number,
  config: Live2DIdleMotionAxisSettings,
) {
  // Incommensurate rates make the path less repetitive while every component remains smooth.
  return Math.sin(time * config.primaryRate * frequency + phase) * config.primaryAmplitude
    + Math.sin(time * config.detailRate * frequency + detailPhase) * config.detailAmplitude
    + Math.sin(time * config.chaosRate * frequency + chaosPhase) * config.chaosAmplitude
}

/**
 * Creates a smoothed procedural cursor for idle Live2D model movement.
 *
 * The controller follows a continuously changing, randomized path with a damped
 * spring. `reset` seeds the path from the current output for a smooth handoff.
 */
export function createLive2DIdleMouseMotion(
  modelSize: MaybeRefOrGetter<Live2DModelSize>,
  options: Live2DIdleMouseMotionOptions = {},
): Live2DIdleMouseMotion {
  const random = options.random ?? Math.random
  const offset = shallowRef<Live2DModelMouseOffset>({ x: 0, y: 0 })
  const direction = shallowRef<Live2DLookDirection>({ x: 0, y: 0 })
  const phaseX = random() * Math.PI * 2
  const phaseY = random() * Math.PI * 2
  const phaseDetail = random() * Math.PI * 2
  const phaseChaosX = random() * Math.PI * 2
  const phaseChaosY = random() * Math.PI * 2
  const phaseSpeed = random() * Math.PI * 2
  let target = { x: 0, y: 0 }
  let current = { x: 0, y: 0 }
  let velocity = { x: 0, y: 0 }
  let wanderTime = 0
  let lastUpdateAt = -1

  function getSettings(): Live2DIdleMotionSettings {
    return toValue(options.settings) ?? defaultLive2DIdleMotionSettings
  }

  function getFrequency(settings: Live2DIdleMotionSettings) {
    const configuredFrequency = settings.frequency
    return Number.isFinite(configuredFrequency) ? Math.max(0.25, configuredFrequency) : 1
  }

  function getWanderTarget() {
    const settings = getSettings()
    const frequency = getFrequency(settings)

    return {
      x: getWanderAxis(wanderTime, frequency, phaseX, phaseDetail, phaseChaosX, settings.x),
      y: getWanderAxis(wanderTime, frequency, phaseY, phaseDetail, phaseChaosY, settings.y),
    }
  }

  function getWanderSpeed(frequency: number, settings: Live2DIdleMotionTuning) {
    // A slow harmonic changes the pace from stopped to twice the base speed without changing direction abruptly.
    return 1 + Math.sin(wanderTime * settings.speedRate * frequency + phaseSpeed) * settings.speedVariation
  }

  function updateAxis(
    currentValue: number,
    velocityValue: number,
    targetValue: number,
    timeDelta: number,
    settings: Live2DIdleMotionTuning,
  ) {
    const acceleration = settings.springStiffness * (targetValue - currentValue) - settings.springDamping * velocityValue
    const nextVelocity = velocityValue + acceleration * timeDelta

    return {
      value: currentValue + nextVelocity * timeDelta,
      velocity: nextVelocity,
    }
  }

  function update(now: number, timeDelta: number) {
    const safeTimeDelta = Math.min(Math.max(timeDelta, 0), 0.05)
    if (safeTimeDelta === 0)
      return

    if (now < lastUpdateAt)
      wanderTime = 0
    const settings = getSettings()
    const frequency = getFrequency(settings)
    wanderTime += safeTimeDelta * getWanderSpeed(frequency, settings)
    lastUpdateAt = now
    target = getWanderTarget()

    const nextX = updateAxis(current.x, velocity.x, target.x, safeTimeDelta, settings)
    const nextY = updateAxis(current.y, velocity.y, target.y, safeTimeDelta, settings)
    current = { x: nextX.value, y: nextY.value }
    velocity = { x: nextX.velocity, y: nextY.velocity }
    direction.value = { ...current }
    offset.value = mapLive2DMouseDisplacementToModelOffset(current, toValue(modelSize))
  }

  function reset(nextOffset: Live2DModelMouseOffset = { x: 0, y: 0 }) {
    const size = toValue(modelSize)
    const widthScale = size.width * 0.02
    const heightScale = size.height * 0.04

    current = {
      x: widthScale === 0 ? 0 : -nextOffset.x / widthScale,
      y: heightScale === 0 ? 0 : nextOffset.y / heightScale,
    }
    target = { ...current }
    velocity = { x: 0, y: 0 }
    wanderTime = 0
    lastUpdateAt = -1
    direction.value = { ...current }
    offset.value = { ...nextOffset }
  }

  return { offset, direction, update, reset }
}
