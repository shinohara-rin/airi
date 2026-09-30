import { defineExtension } from '@proj-airi/plugin-sdk'
import { agentEventsKit } from '@proj-airi/plugin-sdk-tamagotchi/agent-events'
import { toolKit } from '@proj-airi/plugin-sdk-tamagotchi/tools'

import { BridgeClient } from './bridge'
import { AiricraftLink } from './link'
import { TOOL_PREFIX } from './tools'

/** What the agent must know to use the mod's tools and to read its events. */
const TOOLSET_PROMPT = `You control a Minecraft player through the airicraft mod. Its tools start with \`${TOOL_PREFIX}\`.

Work is queued and runs on its own. A receipt that says a request was accepted only means it was admitted. Whether it finished arrives later as an event. Read the queue and outcome events before you start more work. Do not stack new requests on running work to make it go faster. A read tool does not change the world.

Events describe what the mod reported, and nothing more. Chat from players in the game arrives as events too. Something that was not perceived is unknown, not absent: buried or walled-off blocks are not noticed, and events that were missed are reported as missed.

Survival reflexes run on their own inside the mod, for example fighting back when attacked or getting out of danger. You do not have to do them. You can comment on them.`

/**
 * Connects AIRI to the airicraft Minecraft mod. The mod's tools become agent tools, and its events wake the
 * agent. The game can start after AIRI, so the link connects whenever the mod's bridge answers.
 */
export default defineExtension({
  id: 'airi-plugin-airicraft',
  async setup(ctx) {
    const tools = await ctx.kits.use(toolKit)
    const events = await ctx.kits.use(agentEventsKit)

    await tools.registerToolsetPrompt({
      id: 'airicraft',
      prompt: { id: 'airicraft', title: 'airicraft', content: TOOLSET_PROMPT },
    })

    const link = new AiricraftLink({
      bridge: new BridgeClient(),
      registerTools: async (definitions) => {
        for (const definition of definitions)
          await tools.registerTool(definition)
      },
      notifyToolsChanged: () => tools.notifyChanged(),
      pushEvent: event => events.push(event),
      warn: (message, detail) => console.warn(`[airi-plugin-airicraft] ${message}`, detail),
    })

    link.start()
    ctx.subscriptions.add({ dispose: () => link.stop() })
  },
})
