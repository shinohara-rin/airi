import type { AgentEventInput } from '@proj-airi/plugin-sdk-tamagotchi/agent-events'
import type { PluginToolDefinition } from '@proj-airi/plugin-sdk-tamagotchi/tools'

import type { MockBridge } from './mock-bridge'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BridgeClient } from '../src/bridge'
import { AiricraftLink } from '../src/link'
import { startMockBridge } from './mock-bridge'

let mock: MockBridge
let dir: string
let stateFile: string
let link: AiricraftLink | undefined

beforeEach(async () => {
  mock = await startMockBridge()
  dir = mkdtempSync(join(tmpdir(), 'airicraft-link-'))
  stateFile = join(dir, 'bridge-state.json')
  writeFileSync(stateFile, JSON.stringify({ port: mock.port, token: mock.token }))
})

afterEach(async () => {
  link?.stop()
  link = undefined
  await mock.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const tool = (name: string) => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } })
const event = (seqNo: number, type: string, payload: Record<string, unknown> = {}) => ({ seqNo, type, payload })

function createLink() {
  const pushed: AgentEventInput[] = []
  const registered: PluginToolDefinition[] = []
  const notifyToolsChanged = vi.fn(async () => {})
  link = new AiricraftLink({
    bridge: new BridgeClient({ stateFile }),
    pollIntervalMs: 15,
    registerTools: async (tools) => {
      registered.push(...tools)
    },
    notifyToolsChanged,
    pushEvent: async (input) => {
      pushed.push(input)
    },
    warn: () => {},
  })
  return { link, pushed, registered, notifyToolsChanged }
}

async function until(condition: () => boolean, ms = 3000) {
  await vi.waitFor(() => expect(condition()).toBe(true), { timeout: ms, interval: 10 })
}

describe('airicraft link', () => {
  it('registers the tools of the mod when its bridge answers and tells the host', async () => {
    mock.tools = [tool('observe'), tool('say')]
    const { link, registered, notifyToolsChanged } = createLink()

    link.start()
    await until(() => registered.length > 0)

    expect(registered.map(item => item.id)).toEqual(['ac_observe'])
    expect(registered[0].isAvailable?.()).toBe(true)
    expect(notifyToolsChanged).toHaveBeenCalled()
  })

  it('starts at the present and hands on later events with their trigger', async () => {
    mock.events = [event(1, 'task.failed', { reason: 'old' })]
    const { link, pushed } = createLink()

    link.start()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(pushed).toEqual([])

    mock.events.push(
      event(2, 'social.player_addressed_agent', { message: 'hi' }),
      event(3, 'action_graph.goal_started'),
      event(4, 'food.eaten'),
    )
    await until(() => pushed.length === 2)

    expect(pushed).toEqual([
      { type: 'airicraft.social.player_addressed_agent', text: '[airicraft] social.player_addressed_agent message=hi', trigger: 'flush', meta: { seqNo: 2 } },
      { type: 'airicraft.food.eaten', text: '[airicraft] food.eaten', trigger: 'piggyback', meta: { seqNo: 4 } },
    ])
  })

  it('reports events that the mod dropped from its buffer', async () => {
    mock.events = [event(1, 'food.eaten')]
    const { link, pushed } = createLink()
    link.start()
    await new Promise(resolve => setTimeout(resolve, 60))

    mock.oldestSeqNo = 5
    mock.events = [event(5, 'task.failed'), event(6, 'task.completed')]
    await until(() => pushed.some(item => item.type === 'airicraft.events_missed'))

    expect(pushed[0]).toEqual({
      type: 'airicraft.events_missed',
      text: '[airicraft] airicraft event buffer overflowed: events 2 to 4 were not delivered',
      trigger: 'flush',
    })
  })

  it('gives one notice when the bridge is lost, makes the tools unavailable, and one when it returns', async () => {
    mock.tools = [tool('observe')]
    const { link, pushed, registered, notifyToolsChanged } = createLink()
    link.start()
    await until(() => registered.length > 0)
    const changesBefore = notifyToolsChanged.mock.calls.length

    await mock.close()
    await until(() => pushed.some(item => item.type === 'airicraft.bridge_lost'))
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(pushed.filter(item => item.type === 'airicraft.bridge_lost')).toHaveLength(1)
    expect(registered[0].isAvailable?.()).toBe(false)
    expect(notifyToolsChanged.mock.calls.length).toBeGreaterThan(changesBefore)

    // The mod restarts with a new port and token and rewrites its discovery file.
    mock = await startMockBridge()
    mock.tools = [tool('observe'), tool('navigate_to')]
    writeFileSync(stateFile, JSON.stringify({ port: mock.port, token: mock.token }))
    await until(() => pushed.some(item => item.type === 'airicraft.bridge_connected'))

    expect(registered.map(item => item.id)).toContain('ac_navigate_to')
    expect(registered.at(-1)?.isAvailable?.()).toBe(true)
  })

  it('gives no lost notice when the game was never running', async () => {
    await mock.close()
    const { link, pushed } = createLink()

    link.start()
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(pushed).toEqual([])
  })

  it('hands nothing on after stop', async () => {
    const { link, pushed } = createLink()
    link.start()
    await new Promise(resolve => setTimeout(resolve, 40))
    link.stop()

    mock.events.push(event(2, 'task.failed'))
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(pushed).toEqual([])
  })
})
