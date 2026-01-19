import type { ConsciousEvent, ConsciousMachineContext, ConsciousMachineInput, LLMResponse } from './types'

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
    currentContext: null,
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
      hasQueuedEvents: ({ context }: { context: ConsciousMachineContext }) => hasQueuedEvents(context),
      shouldRetry: ({ context }: { context: ConsciousMachineContext }) => shouldRetry(context, maxRetries),
      allActionsDone: ({ context }: { context: ConsciousMachineContext }) => allActionsDone(context),
    },
    actions: {
      enqueueEvent: assign(({ context, event }: { context: ConsciousMachineContext, event: ConsciousEvent }) => {
        if (event.type !== 'ENQUEUE_EVENT')
          return context
        return enqueueEvent(context, event.event)
      }),

      dequeueEvent: assign(({ context }: { context: ConsciousMachineContext }) => dequeueEvent(context)),

      clearCurrentEvent: assign(({ context }: { context: ConsciousMachineContext }) => ({
        ...clearCurrentEvent(context),
        currentContext: null,
      })),

      markActionStarted: assign(({ context, event }: { context: ConsciousMachineContext, event: ConsciousEvent }) => {
        if (event.type !== 'ACTION_STARTED')
          return context
        return markActionStarted(context, event.actionId)
      }),

      markActionCompleted: assign(({ context, event }: { context: ConsciousMachineContext, event: ConsciousEvent }) => {
        if (event.type !== 'ACTION_COMPLETED')
          return context
        return markActionCompleted(context, event.actionId)
      }),

      incrementRetry: assign(({ context }: { context: ConsciousMachineContext }) => incrementRetry(context)),
      resetRetry: assign(({ context }: { context: ConsciousMachineContext }) => resetRetry(context)),
      clearAllActions: assign(({ context }: { context: ConsciousMachineContext }) => clearAllActions(context)),

      notifyStateChange: (_: unknown, params: { state: string }) => {
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

      executePendingActions: fromPromise(async ({ input: ctx }: { input: any }) => {
        const { actions } = ctx
        if (!Array.isArray(actions) || actions.length === 0)
          return

        await input.executeActions(actions)
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
            actions: [
              assign(({ event }) => ({
                currentContext: (event as any).output as string,
              })),
            ],
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
          input: ({ context }: { context: ConsciousMachineContext }) => ({
            systemPrompt: 'brain-prompt',
            userMessage: context.currentContext ?? '',
          }),
          onDone: {
            target: 'evaluating',
            actions: [
              assign(({ event }) => ({
                lastResponse: (event as any).output,
              })),
              assign(({ context, event }) => updateBlackboard(context, (event as any).output as LLMResponse)),
              assign(({ context, event }) => addPendingActions(context, ((event as any).output as LLMResponse).actions)),
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
            guard: ({ context }: { context: ConsciousMachineContext }) => context.pendingActions.size > 0,
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
        invoke: {
          src: 'executePendingActions',
          input: ({ context }: { context: ConsciousMachineContext }) => ({
            actions: [...context.pendingActions.values()],
          }),
        },
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
            guard: ({ context }: { context: ConsciousMachineContext }) => hasQueuedEvents(context) && allActionsDone(context),
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
