import type { GenerationProvider } from '@proj-airi/provider-inference'
import type { Tool } from '@xsai/shared-chat'

import type { AgentLLMPort } from '../contracts/llm-port'
import type { AssistantTurn, Conversation } from '../messages/types'
import type { StreamOptions } from '../types/llm'
import type { AgentTurnResult } from './agent-loop'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentLoop } from './agent-loop'

const provider = {} as unknown as GenerationProvider

type Script = (conversation: Conversation, options: StreamOptions) => Promise<void> | void

/** A model that runs one script per request and records the conversations it received. */
function scriptedLlm(...scripts: Script[]) {
  const conversations: Conversation[] = []
  const llm: AgentLLMPort = {
    stream: async (_model, _provider, conversation, options = {}) => {
      conversations.push(structuredClone(conversation))
      const script = scripts[Math.min(conversations.length - 1, scripts.length - 1)]
      await script(conversation, options)
    },
  }
  return { llm, conversations }
}

function say(text: string, tokens = 10): Script {
  return async (_conversation, options) => {
    await options.onStreamEvent?.({ type: 'text-delta', text })
    await options.onGeneratedTurn?.({
      type: 'assistant',
      id: `assistant-${text}`,
      status: 'completed',
      rounds: [{ id: 'round', content: [{ type: 'text', text }], toolInvocations: [], projectionIssues: [] }],
    } satisfies AssistantTurn)
    await options.onUsage?.({ totalTokens: tokens, source: 'reported' })
  }
}

function createLoop(llm: AgentLLMPort, overrides: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {}) {
  const settled: AgentTurnResult[] = []
  const loop = new AgentLoop({
    llm,
    resolveRequest: () => ({ model: 'm', chatProvider: provider, providerId: 'p', systemPrompt: 'You are the character.' }),
    onTurnSettled: (result) => { settled.push(result) },
    ...overrides,
  })
  return { loop, settled }
}

async function waitFor(condition: () => boolean) {
  await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2000 })
}

const chat = (text: string) => ({ type: 'chat.message', source: 'stage', text })

describe('agentLoop', () => {
  const loops: AgentLoop[] = []

  afterEach(async () => {
    await Promise.all(loops.splice(0).map(loop => loop.stop()))
    vi.useRealTimers()
  })

  function start(...args: Parameters<typeof createLoop>) {
    const created = createLoop(...args)
    loops.push(created.loop)
    created.loop.start()
    return created
  }

  it('answers a flush event with one turn and keeps the exchange as history', async () => {
    const { llm, conversations } = scriptedLlm(say('Hello!'))
    const { loop, settled } = start(llm)

    loop.push(chat('hi'), { trigger: 'flush' })
    await waitFor(() => settled.length === 1)

    expect(settled[0].outcome).toBe('completed')
    expect(settled[0].text).toBe('Hello!')
    expect(conversations[0].turns.map(turn => turn.type)).toEqual(['system', 'user'])
    expect(loop.history.map(turn => turn.type)).toEqual(['user', 'assistant'])
  })

  it('sends earlier turns with the next request', async () => {
    const { llm, conversations } = scriptedLlm(say('one'), say('two'))
    const { loop, settled } = start(llm)

    loop.push(chat('first'), { trigger: 'flush' })
    await waitFor(() => settled.length === 1)
    loop.push(chat('second'), { trigger: 'flush' })
    await waitFor(() => settled.length === 2)

    expect(conversations[1].turns.map(turn => turn.type)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('delivers piggyback events with the next waking event and never alone', async () => {
    const { llm, conversations } = scriptedLlm(say('ok'))
    const { loop, settled } = start(llm)

    loop.push({ type: 'speech.ended', source: 'stage', text: 'finished speaking' }, { trigger: 'piggyback' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(conversations).toHaveLength(0)

    loop.push(chat('hi'), { trigger: 'flush' })
    await waitFor(() => settled.length === 1)

    const user = conversations[0].turns[1]
    expect(user.type === 'user' && user.content).toEqual([
      { type: 'text', text: 'finished speaking' },
      { type: 'text', text: 'hi' },
    ])
  })

  it('cancels a turn that has produced nothing when a preempt event arrives, and answers both together', async () => {
    let release: () => void = () => {}
    const blocked: Script = async (_conversation, options) => {
      await new Promise<void>((resolve, reject) => {
        release = resolve
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason))
      })
    }
    const { llm, conversations } = scriptedLlm(blocked, say('handled'))
    const { loop, settled } = start(llm)

    loop.push(chat('slow one'), { trigger: 'flush' })
    await waitFor(() => conversations.length === 1)
    loop.push({ type: 'game.danger', source: 'game', text: 'a creeper is near' }, { trigger: 'preempt' })
    await waitFor(() => settled.length === 2)
    release()

    expect(settled[0].outcome).toBe('preempted')
    expect(settled[1].outcome).toBe('completed')
    expect(settled[1].events.map(event => event.text)).toEqual(['slow one', 'a creeper is near'])
    expect(loop.history.map(turn => turn.type)).toEqual(['user', 'assistant'])
  })

  it('lets a turn that already spoke finish when a preempt event arrives', async () => {
    let finish: () => void = () => {}
    const speaking: Script = async (_conversation, options) => {
      await options.onStreamEvent?.({ type: 'text-delta', text: 'Well, ' })
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      await options.onStreamEvent?.({ type: 'text-delta', text: 'hello.' })
    }
    const { llm, conversations } = scriptedLlm(speaking, say('next'))
    const { loop, settled } = start(llm)

    loop.push(chat('hi'), { trigger: 'flush' })
    await waitFor(() => conversations.length === 1)
    loop.push({ type: 'game.danger', source: 'game', text: 'danger' }, { trigger: 'preempt' })
    finish()
    await waitFor(() => settled.length === 2)

    expect(settled[0].outcome).toBe('completed')
    expect(settled[0].text).toBe('Well, hello.')
    expect(settled[1].events.map(event => event.text)).toEqual(['danger'])
  })

  it('keeps running after a failed turn and does not keep it as history', async () => {
    const failing: Script = () => {
      throw new Error('provider down')
    }
    const { llm } = scriptedLlm(failing, say('back'))
    const { loop, settled } = start(llm)

    loop.push(chat('one'), { trigger: 'flush' })
    await waitFor(() => settled.length === 1)
    loop.push(chat('two'), { trigger: 'flush' })
    await waitFor(() => settled.length === 2)

    expect(settled[0].outcome).toBe('failed')
    expect(settled[1].outcome).toBe('completed')
    expect(loop.history.map(turn => turn.type)).toEqual(['user', 'assistant'])
  })

  it('cuts a long tool receipt and says how much was left out', async () => {
    let receipt: unknown
    const tool = { type: 'function', function: { name: 'observe', parameters: { type: 'object', properties: {} } }, execute: async () => 'x'.repeat(100) } as unknown as Tool
    const useTool: Script = async (_conversation, options) => {
      const [wrapped] = (options.tools ?? []) as Tool[]
      receipt = await wrapped.execute({}, { messages: [], toolCallId: 'call' })
      await say('done')(_conversation, options)
    }
    const { llm } = scriptedLlm(useTool)
    const { loop, settled } = start(llm, {
      maxReceiptChars: 40,
      resolveRequest: () => ({ model: 'm', chatProvider: provider, providerId: 'p', systemPrompt: 's', tools: [tool] }),
    })

    loop.push(chat('look'), { trigger: 'flush' })
    await waitFor(() => settled.length === 1)

    expect(receipt).toBe(`${'x'.repeat(40)}\n[receipt cut: 60 more characters were left out]`)
  })

  it('beats a quiet heartbeat event when idle and backs off', async () => {
    vi.useFakeTimers()
    const { llm, conversations } = scriptedLlm(say('...'))
    const { loop } = start(llm, { heartbeatMs: () => 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    expect(conversations).toHaveLength(1)
    const user = conversations[0].turns[1]
    expect(user.type === 'user' && user.content).toEqual([{ type: 'text', text: '[system] quiet for 1 seconds.' }])

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(conversations).toHaveLength(2)
    loop.interrupt()
  })

  it('turns debounce events into piggyback events while the spend guard is tripped, and still answers chat', async () => {
    vi.useFakeTimers()
    const { llm, conversations } = scriptedLlm(say('expensive', 500), say('cheap'))
    const { loop, settled } = start(llm, { spendGuard: { maxTokens: 100, windowMs: 60_000 } })

    loop.push(chat('first'), { trigger: 'flush' })
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toHaveLength(1)

    loop.push({ type: 'game.percept', source: 'game', text: 'a bird flies by' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(conversations).toHaveLength(1)

    loop.push(chat('hello?'), { trigger: 'flush' })
    await vi.advanceTimersByTimeAsync(10)
    expect(conversations).toHaveLength(2)
    const user = conversations[1].turns.at(-1)
    expect(user?.type === 'user' && user.content.map(part => part.type === 'text' && part.text)).toEqual(['a bird flies by', 'hello?'])
  })

  it('drops the oldest whole exchanges when history passes the limit', async () => {
    const { llm } = scriptedLlm(say('a'.repeat(400)))
    const { loop, settled } = start(llm, { maxHistoryTokens: 250 })

    for (let index = 0; index < 4; index++) {
      loop.push(chat(`message ${index}`), { trigger: 'flush' })
      await waitFor(() => settled.length === index + 1)
    }

    const types = loop.history.map(turn => turn.type)
    expect(types.length).toBeLessThan(8)
    expect(types[0]).toBe('user')
  })

  it('uses the conversation the application builds and keeps no history of its own', async () => {
    const { llm, conversations } = scriptedLlm(say('ok'))
    const { loop, settled } = start(llm, {
      buildConversation: (batch, request) => ({
        turns: [
          { type: 'system', id: 's', authority: 'system', content: [{ type: 'text', text: request.systemPrompt }] },
          { type: 'user', id: 'u', content: [{ type: 'text', text: `stored: ${batch[0].text}` }] },
        ],
      }),
    })

    loop.push(chat('hi'), { trigger: 'flush' })
    await waitFor(() => settled.length === 1)

    const user = conversations[0].turns[1]
    expect(user.type === 'user' && user.content).toEqual([{ type: 'text', text: 'stored: hi' }])
    expect(loop.history).toEqual([])
    expect(settled[0].assistantTurn?.type).toBe('assistant')
  })

  it('drops stale events at delivery and reports them', async () => {
    const { llm, conversations } = scriptedLlm(say('ok'))
    const discarded: string[] = []
    const { loop, settled } = start(llm, {
      isStale: event => event.text === 'stale',
      onDiscarded: events => discarded.push(...events.map(event => event.text)),
    })

    loop.push(chat('stale'), { trigger: 'flush' })
    await waitFor(() => discarded.length === 1)
    loop.push(chat('fresh'), { trigger: 'flush' })
    await waitFor(() => settled.length === 1)

    expect(conversations).toHaveLength(1)
    expect(settled[0].events.map(event => event.text)).toEqual(['fresh'])
  })

  it('discards the events of an interrupted turn instead of answering them again', async () => {
    const blocked: Script = (_conversation, options) => new Promise<void>((_resolve, reject) => {
      options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason))
    })
    const { llm, conversations } = scriptedLlm(blocked, say('next'))
    const { loop, settled } = start(llm)

    loop.push(chat('cancel me'), { trigger: 'flush' })
    await waitFor(() => conversations.length === 1)
    loop.interrupt(event => event.text === 'other')
    expect(settled).toHaveLength(0)
    loop.interrupt(event => event.text === 'cancel me')
    await waitFor(() => settled.length === 1)
    loop.push(chat('after'), { trigger: 'flush' })
    await waitFor(() => settled.length === 2)

    expect(settled[0].outcome).toBe('cancelled')
    expect(settled[1].events.map(event => event.text)).toEqual(['after'])
  })

  it('runs only the events selectEvents chooses and keeps the rest for the next turn', async () => {
    const { llm } = scriptedLlm(say('a'), say('b'))
    const { loop, settled } = start(llm, {
      selectEvents: batch => batch.filter(event => event.meta?.room === batch[0].meta?.room),
    })

    loop.push({ ...chat('one'), meta: { room: 1 } }, { trigger: 'piggyback' })
    loop.push({ ...chat('two'), meta: { room: 2 } }, { trigger: 'piggyback' })
    loop.push({ ...chat('three'), meta: { room: 1 } }, { trigger: 'flush' })
    await waitFor(() => settled.length === 2)

    expect(settled.map(result => result.events.map(event => event.text))).toEqual([['one', 'three'], ['two']])
  })

  it('drops events pushed after stop', async () => {
    const { llm, conversations } = scriptedLlm(say('x'))
    const { loop } = start(llm)
    await loop.stop()

    expect(loop.push(chat('late'), { trigger: 'flush' })).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(conversations).toHaveLength(0)
  })
})
