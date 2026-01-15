import type { PerceptionContext, PerceptionEvent, PerceptionMachineInput } from './types'

import { assign, createActor, fromCallback, setup } from 'xstate'

import { EVENT_KEYS, SALIENCY_RULES, WINDOW_SIZE } from '../saliency-rules'
import {
  advanceSlot,
  createCounter,
  incrementCounter,
  markThresholdTriggered,
  resetCounter,
  updateEntityBelief,
} from './actions'
import { hasReachedThreshold, rulePredicatePasses } from './guards'

/**
 * Create the perception state machine
 */
export function createPerceptionMachine(input: PerceptionMachineInput) {
  const slotMs = input.slotMs ?? 20
  const windowSize = input.windowSize ?? WINDOW_SIZE
  const maxDistance = input.maxDistance ?? 32

  // Initialize all counters upfront (fixed set)
  const initialCounters = new Map()
  for (const key of EVENT_KEYS) {
    initialCounters.set(key, createCounter())
  }

  const machine = setup({
    types: {
      context: {} as PerceptionContext,
      events: {} as PerceptionEvent,
    },
    actors: {
      slotTimer: fromCallback(({ sendBack, input }: { sendBack: any, input: PerceptionContext }) => {
        const interval = setInterval(() => {
          sendBack({ type: 'TICK' })
        }, input.config.slotMs)

        return () => clearInterval(interval)
      }),
    },
    actions: {
      updateEntity: assign(({ context, event }) => {
        if (event.type !== 'RAW_EVENT')
          return context
        return updateEntityBelief(context, event.event)
      }),

      ingestToSaliency: assign(({ context, event }) => {
        if (event.type !== 'RAW_EVENT')
          return context

        const rawEvent = event.event
        const rule = SALIENCY_RULES[rawEvent.modality]?.[rawEvent.kind]

        if (!rule)
          return context
        if (!rulePredicatePasses(rawEvent, rule))
          return context

        // Increment counter
        return incrementCounter(context, rule.key)
      }),

      checkThreshold: assign(({ context, event }) => {
        if (event.type !== 'RAW_EVENT')
          return context

        const rawEvent = event.event
        const rule = SALIENCY_RULES[rawEvent.modality]?.[rawEvent.kind]

        if (!rule)
          return context

        // Check if threshold reached
        if (hasReachedThreshold(context, rule.key, rule.threshold)) {
          // Mark triggered
          let newContext = markThresholdTriggered(context, rule.key)
          // Reset counter
          newContext = resetCounter(newContext, rule.key)

          // Emit signal via callback
          if (input.onSignal) {
            const signal = rule.buildSignal(rawEvent)
            input.onSignal(signal)
          }

          return newContext
        }

        return context
      }),

      advanceWindow: assign(({ context }) => {
        return advanceSlot(context)
      }),
    },
  }).createMachine({
    id: 'perception',
    initial: 'idle',
    context: {
      entities: new Map(),
      counters: initialCounters,
      currentSlot: 0,
      config: {
        slotMs,
        windowSize,
        maxDistance,
      },
    },
    states: {
      idle: {
        on: {
          START: {
            target: 'collecting',
          },
        },
      },
      collecting: {
        invoke: {
          src: 'slotTimer',
          input: ({ context }) => context,
        },
        on: {
          RAW_EVENT: {
            actions: ['updateEntity', 'ingestToSaliency', 'checkThreshold'],
          },
          TICK: {
            actions: ['advanceWindow'],
          },
          STOP: {
            target: 'idle',
          },
        },
      },
    },
  })

  return machine
}

/**
 * Create and start a perception actor
 */
export function createPerceptionActor(input: PerceptionMachineInput) {
  const machine = createPerceptionMachine(input)
  const actor = createActor(machine)
  return actor
}

/**
 * Export types for external usage
 */
export type PerceptionMachine = ReturnType<typeof createPerceptionMachine>
export type PerceptionActor = ReturnType<typeof createPerceptionActor>
