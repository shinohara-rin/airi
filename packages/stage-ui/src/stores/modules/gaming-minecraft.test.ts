import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMinecraftContext } from '../chat/context-providers/minecraft'
import { useMinecraftStore } from './gaming-minecraft'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
}))

vi.mock('../mods/api/channel-server', () => ({
  useModsServerChannelStore: () => ({
    onContextUpdate: (handler: (event: unknown) => void) => {
      handlers.set('context:update', handler)
      return () => handlers.delete('context:update')
    },
    onEvent: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
  }),
}))

const airicraftSource = { id: 'airicraft-1234', extension: { id: 'airicraft' } }

function emit(type: string, data: unknown, source?: unknown) {
  handlers.get(type)?.({ type, data, metadata: source ? { source } : undefined })
}

function contextUpdate(lane: string, text: string) {
  return { id: 'event-1', contextId: `airicraft:${lane}`, lane, strategy: 'replace-self', text }
}

describe('minecraft store with the airicraft mod', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    handlers.clear()
  })

  it('recognizes the airicraft module in the registry', () => {
    const store = useMinecraftStore()
    store.initialize()

    emit('registry:modules:sync', { modules: [{ name: 'airicraft', identity: airicraftSource }] })

    expect(store.serviceConnected).toBe(true)
    expect(store.serviceName).toBe('airicraft')
  })

  it('keeps the status lane as the latest context and records chat only as traffic', () => {
    const store = useMinecraftStore()
    store.initialize()

    emit('context:update', contextUpdate('status', 'The Minecraft body is in minecraft:overworld at 1 64 -3.'), airicraftSource)
    emit('context:update', contextUpdate('chat', 'Steve: hello'), airicraftSource)

    expect(store.latestRuntimeContextText).toBe('The Minecraft body is in minecraft:overworld at 1 64 -3.')
    expect(store.trafficEntries.map(entry => entry.summary)).toEqual([
      'status: The Minecraft body is in minecraft:overworld at 1 64 -3.',
      'chat: Steve: hello',
    ])
  })

  it('records a broadcast command as Minecraft traffic', () => {
    const store = useMinecraftStore()
    store.initialize()

    emit('spark:command', { id: 'c1', commandId: 'c1', intent: 'action', interrupt: false, priority: 'normal' })

    expect(store.trafficEntries.map(entry => entry.summary)).toEqual(['action -> broadcast'])
  })

  it('tells the chat model how to command the body', () => {
    const store = useMinecraftStore()
    store.initialize()
    emit('registry:modules:sync', { modules: [{ name: 'airicraft', identity: airicraftSource }] })
    emit('context:update', contextUpdate('status', 'No work is running.'), airicraftSource)

    const context = createMinecraftContext()

    expect(context?.text).toContain('destinations ["airicraft"]')
    expect(context?.text).toContain('The body is currently online.')
    expect(context?.text).toContain('Latest body status: No work is running.')
  })

  it('keeps the Mineflayer bot context for minecraft-bot', () => {
    const store = useMinecraftStore()
    store.initialize()
    emit('context:update', contextUpdate('game', 'Bot is idle.'), { id: 'minecraft-bot' })

    const context = createMinecraftContext()

    expect(store.serviceName).toBe('minecraft-bot')
    expect(context?.text).toContain('Latest Minecraft bot context: Bot is idle.')
  })
})
