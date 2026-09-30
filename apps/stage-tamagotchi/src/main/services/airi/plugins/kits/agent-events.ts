import type { KitRef } from '@proj-airi/plugin-sdk'
import type { AgentEventInput, AgentEventsKitRuntime } from '@proj-airi/plugin-sdk-tamagotchi/agent-events'

import type { ElectronPluginAgentEvent } from '../../../../../shared/eventa/plugin/agent-events'

import { agentEventsKit } from '@proj-airi/plugin-sdk-tamagotchi/agent-events'

type AgentEventsKitClient = ReturnType<typeof agentEventsKit.createClient>

/**
 * Carries events from extension modules to the stage renderer.
 *
 * State model: only the subscriber list is runtime state. An event with no subscriber is dropped, because
 * an event that waits for a renderer that may never come would wake the agent with stale news.
 */
export class AgentEventSink {
  private readonly listeners = new Set<(event: ElectronPluginAgentEvent) => void>()

  subscribe(listener: (event: ElectronPluginAgentEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: ElectronPluginAgentEvent) {
    for (const listener of this.listeners)
      listener(event)
  }

  clear() {
    this.listeners.clear()
  }
}

/** Binds the kit to the sink. The extension id becomes the event source, so a plugin cannot name another. */
export function createHostAgentEventsKit(options: { sink: AgentEventSink }): KitRef<AgentEventsKitClient> {
  return {
    ...agentEventsKit,
    createClient(runtime) {
      const hostRuntime: AgentEventsKitRuntime = {
        ...runtime,
        agentEvents: {
          push: (event: AgentEventInput) => {
            options.sink.emit({
              source: runtime.extensionId,
              type: event.type,
              text: event.text,
              trigger: event.trigger,
              images: event.images,
              meta: event.meta,
            })
          },
        },
      }

      return agentEventsKit.createClient(hostRuntime)
    },
  }
}
