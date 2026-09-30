import type { ExtensionSetupContext, KitRef } from '@proj-airi/plugin-sdk'

import { DisposableStore } from '@proj-airi/plugin-sdk'
import { agentEventsKit } from '@proj-airi/plugin-sdk-tamagotchi/agent-events'
import { toolKit } from '@proj-airi/plugin-sdk-tamagotchi/tools'
import { describe, expect, it, vi } from 'vitest'

import extension from '../src/index'

describe('airicraft extension', () => {
  it('uses the tool and agent event kits, registers its prompt, and stops its link on dispose', async () => {
    // A game that is not running must not touch the real discovery file of the machine that runs the test.
    vi.stubEnv('AIRICRAFT_BRIDGE_STATE_FILE', '/nonexistent/airicraft-bridge-state.json')
    const registerToolsetPrompt = vi.fn()
    const used: string[] = []
    const subscriptions = new DisposableStore()
    const ctx = {
      subscriptions,
      kits: {
        use: async (kit: KitRef<unknown>) => {
          used.push(kit.id)
          return kit === toolKit ? { registerToolsetPrompt, registerTool: vi.fn(async () => {}), notifyChanged: vi.fn(async () => {}) } : { push: vi.fn() }
        },
      },
    } as unknown as ExtensionSetupContext

    await extension.setup(ctx)

    expect(extension.id).toBe('airi-plugin-airicraft')
    expect(used).toEqual([toolKit.id, agentEventsKit.id])
    expect(registerToolsetPrompt).toHaveBeenCalledWith(expect.objectContaining({ id: 'airicraft', prompt: expect.objectContaining({ content: expect.stringContaining('`ac_`') }) }))
    await subscriptions.dispose()
    vi.unstubAllEnvs()
  })
})
