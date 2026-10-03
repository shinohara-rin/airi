import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

import { useMinecraftStore } from '../../modules/gaming-minecraft'

const MINECRAFT_CONTEXT_ID = 'system:minecraft-integration'

export function createMinecraftContext(): ContextMessage | null {
  const minecraftStore = useMinecraftStore()
  minecraftStore.initialize()

  if (!minecraftStore.configured)
    return null

  const serviceStatus = minecraftStore.serviceConnected ? 'online' : 'offline'
  const runtimeContextText = minecraftStore.latestRuntimeContextText.trim()

  if (minecraftStore.serviceName === 'airicraft') {
    return {
      id: nanoid(),
      contextId: MINECRAFT_CONTEXT_ID,
      strategy: ContextUpdateStrategy.ReplaceSelf,
      text: createAiricraftContextText(serviceStatus, runtimeContextText),
      createdAt: Date.now(),
    }
  }

  return {
    id: nanoid(),
    contextId: MINECRAFT_CONTEXT_ID,
    strategy: ContextUpdateStrategy.ReplaceSelf,
    text: [
      'Minecraft integration is active because AIRI has observed a Minecraft service.',
      'AIRI can oversee a connected Minecraft bot through AIRI server events.',
      'Minecraft can send status and context upward, and AIRI can send high-level guidance back down.',
      'Minecraft context updates are side context for the next turn and do not automatically trigger a new LLM response.',
      `Minecraft service is currently ${serviceStatus}.`,
      runtimeContextText
        ? `Latest Minecraft bot context: ${runtimeContextText}`
        : 'No live Minecraft bot context has been pushed yet.',
      serviceStatus === 'online'
        ? 'The Minecraft service is online, but AIRI should still rely on live bot context before assuming the bot can act.'
        : 'Do not assume the Minecraft bot can act right now unless fresh bot context confirms it.',
    ].join(' '),
    createdAt: Date.now(),
  }
}

/**
 * The airicraft mod is the character's body in Minecraft. It has its own planner and acts on intentions.
 * The reference is docs/ai/adr/2026-10-03-airicraft-minecraft-body.md.
 */
function createAiricraftContextText(serviceStatus: 'online' | 'offline', statusText: string) {
  return [
    'You have a body in Minecraft: the airicraft mod, connected to AIRI as the module "airicraft".',
    'The body has its own planner. It moves, works, fights and chats with other players in the game by itself.',
    'To make the body do something, call builtIn_emitSparkCommand with intent "action" and destinations ["airicraft"].',
    'Put the intention in guidance.options[0].label and the steps in guidance.options[0].steps. Give intentions, not key presses.',
    'The body reports progress for each command as queued, working, done, blocked or dropped.',
    'Its status, game chat and alarms reach you as context. They do not start a new turn by themselves.',
    `The body is currently ${serviceStatus}.`,
    statusText
      ? `Latest body status: ${statusText}`
      : 'The body has not sent a status yet.',
    serviceStatus === 'online'
      ? 'Use the latest body status before you promise what the body can do.'
      : 'Do not send commands to the body until it is online again.',
  ].join(' ')
}
