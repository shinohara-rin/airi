import type { KitClientRuntime } from '@proj-airi/plugin-sdk'
import type { HostDataRecord } from '@proj-airi/plugin-sdk/plugin-host'

import { defineKit } from '@proj-airi/plugin-sdk'
import { array, maxLength, minLength, object, optional, parse, picklist, pipe, record, regex, string, unknown } from 'valibot'

/** How an event wakes the agent. */
export type AgentEventTrigger = 'preempt' | 'flush' | 'debounce' | 'piggyback'

/**
 * One event that a plugin gives to the agent.
 *
 * The text must state only what the plugin can confirm. The host names the plugin as the source and marks
 * the event external, so a plugin cannot pass an event off as a system notice.
 */
export interface AgentEventInput {
  /** The plugin's own name for the event, for example `game.job_finished`. */
  type: string
  /** What the agent reads. */
  text: string
  /**
   * `preempt` cancels a turn that has not produced output. `flush` wakes the agent now with the queued events.
   * `debounce` waits for a quiet gap. `piggyback` never wakes the agent and rides with the next wake.
   * @default 'debounce'
   */
  trigger?: AgentEventTrigger
  /** Image data URLs shown to the model with the text. */
  images?: string[]
  /** Data for observers. The agent never reads it. */
  meta?: HostDataRecord
}

/** The host side of {@link agentEventsKit}. */
export interface AgentEventsKitRuntime extends KitClientRuntime {
  agentEvents?: {
    push: (event: AgentEventInput) => Promise<void> | void
  }
}

export interface AgentEventsKitClient {
  /** Gives the agent one event. Rejects when the event is malformed. */
  push: (event: AgentEventInput) => Promise<void>
}

const MAX_TEXT_CHARS = 4000
const MAX_IMAGES = 4

const agentEventInputSchema = object({
  type: pipe(string(), regex(/^[\w.:-]{1,64}$/, 'type must be 1 to 64 letters, digits, or one of _ . : -')),
  text: pipe(string(), minLength(1), maxLength(MAX_TEXT_CHARS)),
  trigger: optional(picklist(['preempt', 'flush', 'debounce', 'piggyback'])),
  images: optional(pipe(array(pipe(string(), regex(/^data:image\//, 'images must be image data URLs'))), maxLength(MAX_IMAGES))),
  meta: optional(record(string(), unknown())),
})

/**
 * Lets an extension module give events to the agent, next to the tools it registers with `toolKit`.
 *
 * Use when:
 * - A plugin watches something, such as a game or a livestream, and the agent must react to it
 *
 * Expects:
 * - The host provides `agentEvents` when it creates the kit client
 *
 * Returns:
 * - A client whose `push` validates the event and hands it to the host
 */
export const agentEventsKit = defineKit<AgentEventsKitClient>({
  id: 'kit.agent-events',
  version: '1.0.0',
  allowedExposePolicies: ['local-only'],
  defaultExposePolicy: 'local-only',
  createClient(runtime) {
    const { agentEvents } = runtime as AgentEventsKitRuntime

    return {
      async push(event) {
        if (!agentEvents)
          throw new Error('agentEventsKit requires a host agent event runtime.')

        parse(agentEventInputSchema, event)
        await agentEvents.push(event)
      },
    }
  },
})
