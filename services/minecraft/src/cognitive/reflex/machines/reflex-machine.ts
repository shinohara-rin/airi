import type { ReflexEvent, ReflexMachineContext, ReflexMachineInput, ReflexMode } from './types'

import { Vec3 } from 'vec3'
import { assign, createActor, setup } from 'xstate'

import {
  clearActiveBehavior,
  decrementActionsCount,
  incrementActionsCount,
  updateAttention,
  updateContextState,
  updateEnvironment,
  updateSocial,
} from './actions'
import {
  behaviorShouldContinue,
  canEnterAlert,
  canEnterSocial,
  hasActiveActions,
} from './guards'

/**
 * Create initial reflex context
 */
function createInitialContext(input: ReflexMachineInput): ReflexMachineContext {
  return {
    contextState: {
      now: Date.now(),
      self: {
        location: new Vec3(0, 0, 0),
        holding: null,
        health: 20,
        food: 20,
      },
      environment: {
        time: 'Unknown',
        weather: 'clear',
        nearbyPlayers: [],
        nearbyPlayersGaze: [],
        nearbyEntities: [],
        lightLevel: 15,
      },
      social: {
        lastSpeaker: null,
        lastMessage: null,
        lastMessageAt: null,
        lastGreetingAtBySpeaker: {},
        lastGesture: null,
        lastGestureAt: null,
      },
      threat: {
        threatScore: 0,
        lastThreatAt: null,
        lastThreatSource: null,
      },
      attention: {
        lastSignalType: null,
        lastSignalSourceId: null,
        lastSignalAt: null,
      },
    },
    behaviors: input.behaviors,
    runHistory: new Map(),
    activeBehaviorId: null,
    activeBehaviorUntil: null,
    lockedFollowTargetName: null,
    inFlightActionsCount: 0,
  }
}

/**
 * Create the reflex state machine
 */
export function createReflexMachine(input: ReflexMachineInput) {
  const machine = setup({
    types: {
      context: {} as ReflexMachineContext,
      events: {} as ReflexEvent,
    },
    guards: {
      canEnterSocial: ({ context }) => canEnterSocial(context.contextState),
      canEnterAlert: ({ context }) => canEnterAlert(context.contextState),
      hasActiveActions: ({ context }) => hasActiveActions(context),
      behaviorShouldContinue: ({ context }) => behaviorShouldContinue(context),
    },
    actions: {
      updateNow: assign(({ context, event }) => {
        if (event.type !== 'TICK')
          return context
        return updateContextState(context, { now: Date.now() })
      }),

      handleSignal: assign(({ context, event }) => {
        if (event.type !== 'SIGNAL')
          return context

        const signal = event.payload
        const now = Date.now()

        let newContext = updateContextState(context, { now })
        newContext = updateAttention(newContext, {
          lastSignalType: signal.type,
          lastSignalSourceId: signal.sourceId ?? null,
          lastSignalAt: now,
        })

        // Handle specific signal types
        if (signal.type === 'social_gesture') {
          newContext = updateSocial(newContext, {
            lastGesture: signal.metadata?.gesture ?? 'unknown',
            lastGestureAt: now,
          })
        }

        if (signal.type === 'chat_message') {
          const username = signal.metadata?.username ?? signal.sourceId ?? null
          const message = signal.metadata?.message ?? null

          newContext = updateSocial(newContext, {
            lastSpeaker: username,
            lastMessage: message,
            lastMessageAt: now,
          })
        }

        return newContext
      }),

      updateContextFromEvent: assign(({ context, event }) => {
        if (event.type === 'UPDATE_CONTEXT') {
          return updateContextState(context, event.patch)
        }
        if (event.type === 'UPDATE_ENVIRONMENT') {
          return updateEnvironment(context, event.patch)
        }
        return context
      }),

      incrementActions: assign(({ context }) => incrementActionsCount(context)),
      decrementActions: assign(({ context }) => decrementActionsCount(context)),

      notifyModeChange: (_, params: { mode: ReflexMode }) => {
        if (input.onModeChange) {
          input.onModeChange(params.mode)
        }
      },

      notifyBehaviorEnd: () => {
        if (input.onBehaviorEnd) {
          input.onBehaviorEnd()
        }
      },

      clearBehavior: assign(({ context }) => clearActiveBehavior(context)),
    },
  }).createMachine({
    id: 'reflex',
    initial: 'idle',
    context: createInitialContext(input),
    on: {
      SIGNAL: {
        actions: ['handleSignal'],
      },
      UPDATE_CONTEXT: {
        actions: ['updateContextFromEvent'],
      },
      UPDATE_ENVIRONMENT: {
        actions: ['updateContextFromEvent'],
      },
      TASK_STARTED: {
        target: '.work',
        actions: ['incrementActions'],
      },
      TASK_COMPLETED: {
        actions: ['decrementActions'],
      },
      TASK_FAILED: {
        actions: ['decrementActions'],
      },
    },
    states: {
      idle: {
        entry: [
          { type: 'notifyModeChange', params: { mode: 'idle' } },
        ],
        on: {
          MODE_OVERRIDE: [
            {
              target: 'work',
              guard: ({ event }) => event.mode === 'work',
            },
            {
              target: 'wander',
              guard: ({ event }) => event.mode === 'wander',
            },
          ],
        },
        always: [
          {
            target: 'alert',
            guard: 'canEnterAlert',
          },
          {
            target: 'social',
            guard: 'canEnterSocial',
          },
        ],
      },
      social: {
        entry: [
          { type: 'notifyModeChange', params: { mode: 'social' } },
        ],
        on: {
          TICK: [
            {
              target: 'idle',
              guard: 'hasActiveActions',
            },
          ],
        },
        always: [
          {
            target: 'idle',
            guard: ({ context }) => {
              const timeSince = context.contextState.social.lastMessageAt
                ? context.contextState.now - context.contextState.social.lastMessageAt
                : Infinity
              return timeSince > 60_000 // 60 seconds timeout
            },
          },
        ],
      },
      alert: {
        entry: [
          { type: 'notifyModeChange', params: { mode: 'alert' } },
        ],
        always: [
          {
            target: 'idle',
            guard: ({ context }) => {
              return context.contextState.self.health >= 15 && context.contextState.threat.threatScore <= 3
            },
          },
        ],
      },
      work: {
        entry: [
          { type: 'notifyModeChange', params: { mode: 'work' } },
        ],
        always: [
          {
            target: 'idle',
            guard: ({ context }) => !hasActiveActions(context),
          },
        ],
      },
      wander: {
        entry: [
          { type: 'notifyModeChange', params: { mode: 'wander' } },
        ],
        on: {
          MODE_OVERRIDE: {
            target: 'idle',
            guard: ({ event }) => event.mode !== 'wander',
          },
        },
      },
    },
  })

  return machine
}

/**
 * Create and start a reflex actor
 */
export function createReflexActor(input: ReflexMachineInput) {
  const machine = createReflexMachine(input)
  const actor = createActor(machine)
  return actor
}

/**
 * Export types for external usage
 */
export type ReflexMachine = ReturnType<typeof createReflexMachine>
export type ReflexActor = ReturnType<typeof createReflexActor>
