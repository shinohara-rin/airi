import type { MockBridge } from './mock-bridge'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BridgeClient } from '../src/bridge'
import { shapeReceipt, toToolDefinitions } from '../src/tools'
import { startMockBridge } from './mock-bridge'

let mock: MockBridge

beforeEach(async () => {
  mock = await startMockBridge()
})

afterEach(async () => {
  await mock.close()
})

const descriptor = (name: string, parameters: Record<string, unknown> = { type: 'object', properties: {} }) => ({ name, description: `does ${name}`, parameters })

function definitions(names: string[], overrides: { isAvailable?: (name: string) => boolean, maxReceiptChars?: number } = {}) {
  return toToolDefinitions(names.map(name => descriptor(name)), {
    bridge: new BridgeClient({ stateFile: '', fetchImpl: (input, init) => fetch(input, init) }),
    timeoutMs: 5000,
    maxReceiptChars: overrides.maxReceiptChars ?? 20_000,
    isAvailable: overrides.isAvailable ?? (() => true),
  })
}

describe('shapeReceipt', () => {
  it('replaces the event list of observe with a note', () => {
    const shaped = shapeReceipt('observe', JSON.stringify({ current: { hp: 20 }, events: [1, 2, 3] }), 10_000)

    expect(JSON.parse(shaped)).toEqual({
      current: { hp: 20 },
      events: { omitted: 3, note: 'events are delivered to you as events; this list is left out' },
    })
  })

  it('cuts a long receipt and says how much was left out', () => {
    expect(shapeReceipt('inspect_inventory', 'x'.repeat(100), 40)).toBe(`${'x'.repeat(40)}\n[receipt cut: 60 more characters were left out]`)
  })

  it('leaves a short receipt and a receipt that is not JSON alone', () => {
    expect(shapeReceipt('observe', 'not json', 100)).toBe('not json')
  })
})

describe('toToolDefinitions', () => {
  it('prefixes names and hides the tools of the mod planner', () => {
    const tools = definitions(['navigate_to', 'say', 'set_planner_goal', 'observe'])

    expect(tools.map(tool => tool.id)).toEqual(['ac_navigate_to', 'ac_observe'])
  })

  it('skips a name the model cannot use', () => {
    expect(definitions(['ok_name', 'bad name!'])).toHaveLength(1)
  })

  it('takes availability from the link at the time the host asks', () => {
    let up = false
    const [tool] = definitions(['observe'], { isAvailable: () => up })

    expect(tool.isAvailable?.()).toBe(false)
    up = true
    expect(tool.isAvailable?.()).toBe(true)
  })
})

describe('running a tool', () => {
  const state = () => JSON.stringify({ port: mock.port, token: mock.token })

  async function withState<T>(run: (stateFile: string) => Promise<T>) {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'airicraft-plugin-'))
    const file = join(dir, 'bridge-state.json')
    writeFileSync(file, state())
    try {
      return await run(file)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const build = (stateFile: string, names: string[]) => toToolDefinitions(names.map(name => descriptor(name)), {
    bridge: new BridgeClient({ stateFile }),
    timeoutMs: 5000,
    maxReceiptChars: 30,
    isAvailable: () => true,
  })

  it('sends the input without null parameters and returns the receipt text', async () => {
    await withState(async (file) => {
      const [tool] = build(file, ['navigate_to'])

      const receipt = await tool.execute({ x: 1, y: null, z: 3 })

      expect(receipt).toBe('ok navigate_to')
      expect(mock.toolCalls).toEqual([{ name: 'navigate_to', arguments: { x: 1, z: 3 }, timeoutMs: 5000 }])
    })
  })

  it('cuts a long receipt', async () => {
    await withState(async (file) => {
      mock.toolResult = () => ({ result: 'y'.repeat(100) })
      const [tool] = build(file, ['inspect_inventory'])

      expect(await tool.execute({})).toContain('[receipt cut: 70 more characters were left out]')
    })
  })

  it('reports a rejected call as a receipt', async () => {
    await withState(async (file) => {
      const [tool] = build(file, ['reject_me'])

      expect(await tool.execute({})).toBe('[reject_me rejected] invalid_request: Invalid tool arguments')
    })
  })

  it('reports an unreachable bridge as a receipt', async () => {
    await withState(async (file) => {
      await mock.close()
      const [tool] = build(file, ['observe'])

      expect(String(await tool.execute({}))).toMatch(/^\[observe not run\] the airicraft bridge is unreachable/)
    })
    mock = await startMockBridge()
  })

  it('says when the mod attached an image that is not shown', async () => {
    await withState(async (file) => {
      mock.toolResult = () => ({ result: 'seen', imageAttached: true })
      const [tool] = build(file, ['take_a_look'])

      expect(await tool.execute({})).toBe('seen\n[the mod attached an image, which is not shown here]')
    })
  })
})
