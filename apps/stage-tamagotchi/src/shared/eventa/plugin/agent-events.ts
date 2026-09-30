import { defineEventa } from '@moeru/eventa'

/**
 * One event that a plugin gave to the agent, on its way from the main process to the stage renderer.
 *
 * The main process sets `source` to the extension id and always marks the event external. A plugin cannot
 * choose either.
 */
export interface ElectronPluginAgentEvent {
  /** The extension that pushed the event. */
  source: string
  type: string
  text: string
  trigger?: 'preempt' | 'flush' | 'debounce' | 'piggyback'
  images?: string[]
  meta?: Record<string, unknown>
}

export const electronPluginAgentEvent = defineEventa<ElectronPluginAgentEvent>('eventa:event:electron:plugins:agent-event')
