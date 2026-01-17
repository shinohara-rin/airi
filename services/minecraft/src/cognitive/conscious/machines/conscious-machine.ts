import type { ConsciousEvent, ConsciousMachineContext, ConsciousMachineInput } from './types'

import { assign, createActor, fromPromise, setup } from 'xstate'

import { createBlackboard } from '../blackboard-ops'
import {
  addPendingActions,
  clearAllActions,
  clearCurrentEvent,
  dequeueEvent,
  enqueueEvent,
  incrementRetry,
  markActionCompleted,
  markActionStarted,
  resetRetry,
  updateBlackboard,
} from './actions'
import {
  allActionsDone,
  hasQueuedEvents,
  shouldRetry,
} from './guards'

/**
 * Create initial conscious context
 */
function createInitialContext(input: ConsciousMachineInput): ConsciousMachineContext {
  return {
    eventQueue: [],
    blackboard: input.initialBlackboard ?? createBlackboard(),
    pendingActions: new Map(),
    inFlightActions: new Set(),
    retryCount: 0,
    currentEvent: null,
    lastResponse: null,
    nextActionId: 1,
  }
}

/**
 * Create the conscious state machine
 */
export function createConsciousMachine(input: ConsciousMachineInput) {
  const maxRetries = input.maxRetries ?? 3

  const machine = setup({
    types: {
      context: {} as ConsciousMachineContext,
      events: {} as ConsciousEvent,
    },
    guards: {
      hasQueuedEvents: ({ context }) => hasQueuedEvents(context),
      shouldRetry: ({ context }) => shouldRetry(context, maxRetries),
      allActionsDone: ({ context }) => allActionsDone(context),
    },
    actions: {
      enqueueEvent: assign(({ context, event }) => {
        if (event.type !== 'ENQUEUE_EVENT')
          return context
        return enqueueEvent(context, event.event)
      }),

      dequeueEvent: assign(({ context }) => dequeueEvent(context)),

      clearCurrentEvent: assign(({ context }) => clearCurrentEvent(context)),

      updateBlackboard: assign(({ context, event }) => {
        if (event.type !== 'LLM_RESPONSE')
          return context
        return updateBlackboard(context, event.response)
      }),

      addPendingActions: assign(({ context, event }) => {
        if (event.type !== 'LLM_RESPONSE')
          return context
        return addPendingActions(context, event.response.actions)
      }),

      markActionStarted: assign(({ context, event }) => {
        if (event.type !== 'ACTION_STARTED')
          return context
        return markActionStarted(context, event.actionId)
      }),

      markActionCompleted: assign(({ context, event }) => {
        if (event.type !== 'ACTION_COMPLETED')
          return context
        return markActionCompleted(context, event.actionId)
      }),

      incrementRetry: assign(({ context }) => incrementRetry(context)),
      resetRetry: assign(({ context }) => resetRetry(context)),
      clearAllActions: assign(({ context }) => clearAllActions(context)),

      notifyStateChange: (_, params: { state: string }) => {
        if (input.onStateChange) {
          input.onStateChange(params.state as any)
        }
      },
    },
    actors: {
      buildContext: fromPromise(async ({ input: ctx }: { input: any }) => {
        const { event, blackboard } = ctx
        return await input.buildContext(event, blackboard)
      }),

      callLLM: fromPromise(async ({ input: ctx }: { input: any }) => {
        const { systemPrompt, userMessage } = ctx
        return await input.callLLM(systemPrompt, userMessage)
      }),

      executeAction: fromPromise(async ({ input: ctx }: { input: any }) => {
        const { action } = ctx
        await input.executeAction(action)
      }),
    },
  }).createMachine({
    id: 'conscious',
    initial: 'idle',
    context: createInitialContext(input),
    on: {
      ENQUEUE_EVENT: {
        actions: ['enqueueEvent'],
      },
    },
    states: {
      idle: {
        entry: [
          { type: 'notifyStateChange', params: { state: 'idle' } },
        ],
        always: [
          {
            target: 'thinking',
            guard: 'hasQueuedEvents',
          },
        ],
      },
      thinking: {
        entry: [
          { type: 'notifyStateChange', params: { state: 'thinking' } },
          'dequeueEvent',
        ],
        invoke: {
          src: 'buildContext',
          input: ({ context }: { context: ConsciousMachineContext }) => ({
            event: context.currentEvent,
            blackboard: context.blackboard,
          }),
          onDone: {
            target: 'deciding',
          },
          onError: {
            target: 'idle',
            actions: ['clearCurrentEvent'],
          },
        },
      },
      deciding: {
        entry: [
          { type: 'notifyStateChange', params: { state: 'deciding' } },
        ],
        invoke: {
          src: 'callLLM',
          input: () => ({
            systemPrompt: 'brain-prompt', // Simplified for now
            userMessage: 'context', // Will be replaced with actual context
          }),
          onDone: {
            target: 'evaluating',
            actions: [
              assign(({ event }) => ({
                lastResponse: event.output,
              })),
              'updateBlackboard',
              'addPendingActions',
            ],
          },
          onError: [
            {
              target: 'deciding',
              guard: 'shouldRetry',
              actions: ['incrementRetry'],
            },
            {
              target: 'idle',
              actions: ['resetRetry', 'clearCurrentEvent'],
            },
          ],
        },
      },
      evaluating: {
        entry: [
          'resetRetry',
          'clearCurrentEvent',
        ],
        always: [
          {
            target: 'executing',
            guard: ({ context }) => context.pendingActions.size > 0,
          },
          {
            target: 'idle',
          },
        ],
      },
      executing: {
        entry: [
          { type: 'notifyStateChange', params: { state: 'executing' } },
        ],
        on: {
          ACTION_STARTED: {
            actions: ['markActionStarted'],
          },
          ACTION_COMPLETED: {
            actions: ['markActionCompleted'],
          },
          ACTION_FAILED: {
            actions: ['markActionCompleted'],
          },
        },
        always: [
          {
            target: 'thinking',
            guard: ({ context }) => hasQueuedEvents(context) && allActionsDone(context),
          },
          {
            target: 'idle',
            guard: 'allActionsDone',
          },
        ],
      },
    },
  })

  return machine
}

/**
 * Create and start a conscious actor
 */
export function createConsciousActor(input: ConsciousMachineInput) {
  const machine = createConsciousMachine(input)
  const actor = createActor(machine)
  return actor
}

/**
 * Export types for external usage
 */
export type ConsciousMachine = ReturnType<typeof createConsciousMachine>
export type ConsciousActor = ReturnType<typeof createConsciousActor>
