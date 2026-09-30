import type { AgentEventInput } from '@proj-airi/plugin-sdk-tamagotchi/agent-events'
import type { PluginToolDefinition } from '@proj-airi/plugin-sdk-tamagotchi/tools'

import type { BridgeClient } from './bridge'

import { BridgeUnreachable } from './bridge'
import { deliveryFor, eventText } from './events'
import { toToolDefinitions } from './tools'

type LinkState = 'unknown' | 'up' | 'down'

export interface AiricraftLinkOptions {
  bridge: BridgeClient
  /** How often the event feed is polled. @default 300 */
  pollIntervalMs?: number
  /** Longest run of one tool through the bridge. @default 120000 */
  toolTimeoutMs?: number
  /** Longest tool receipt handed to the agent, in characters. @default 20000 */
  maxReceiptChars?: number
  /** Registers tools with the host. Registering a tool again replaces it. */
  registerTools: (tools: PluginToolDefinition[]) => Promise<void>
  /** Asks the host to refresh what the agent can call. */
  notifyToolsChanged: () => Promise<void>
  pushEvent: (event: AgentEventInput) => Promise<void>
  warn?: (message: string, detail?: unknown) => void
}

/**
 * Keeps the agent in step with the mod: registers the mod's tools when its bridge answers, and turns the mod's
 * event feed into agent events.
 *
 * State model: `state` is the last poll outcome, `cursor` is the last event sequence number that was handed on,
 * and `available` is the set of tool names the mod listed on the last connection. The link starts at the
 * present when it connects, so events from before a connection are never delivered. A restart of the game
 * reconnects at the new present and says so.
 *
 * Ownership: `start` runs one poll loop and `stop` ends it. A poll in flight when `stop` runs finishes its
 * request and hands nothing on.
 */
export class AiricraftLink {
  private state: LinkState = 'unknown'
  private cursor: number | null = null
  private available = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true

  constructor(private readonly options: AiricraftLinkOptions) {}

  start() {
    if (!this.stopped)
      return
    this.stopped = false
    void this.poll()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule() {
    if (!this.stopped)
      this.timer = setTimeout(() => void this.poll(), this.options.pollIntervalMs ?? 300)
  }

  private async poll() {
    if (this.stopped)
      return

    try {
      const feed = await this.options.bridge.recentEvents(this.cursor)
      if (this.stopped)
        return

      await this.setState('up')
      if (this.cursor === null) {
        this.cursor = feed.latestSeqNo
      }
      else {
        if (feed.truncated)
          await this.notice('events_missed', `airicraft event buffer overflowed: events ${this.cursor + 1} to ${feed.oldestSeqNo - 1} were not delivered`)
        for (const event of feed.events)
          await this.handOn(event)
        this.cursor = Math.max(this.cursor, feed.latestSeqNo)
      }
    }
    catch (error) {
      if (error instanceof BridgeUnreachable)
        await this.setState('down', error.message)
      else
        this.options.warn?.('airicraft poll failed', error)
    }

    this.schedule()
  }

  /** One notice for each change of state, so a dead bridge does not flood the agent. */
  private async setState(next: LinkState, detail?: string) {
    if (next === this.state)
      return

    const previous = this.state
    this.state = next
    if (next === 'up') {
      // Start at the present after every connection.
      this.cursor = null
      await this.refreshTools()
      if (previous === 'down')
        await this.notice('bridge_connected', 'airicraft bridge is reachable again; events before this point were not delivered')
    }
    else {
      this.available = new Set()
      await this.options.notifyToolsChanged().catch(error => this.options.warn?.('airicraft tool change notice failed', error))
      if (previous === 'up')
        await this.notice('bridge_lost', `airicraft bridge stopped answering${detail ? `: ${detail}` : ''}`)
    }
  }

  private async refreshTools() {
    try {
      const descriptors = await this.options.bridge.listTools()
      const tools = toToolDefinitions(descriptors, {
        bridge: this.options.bridge,
        timeoutMs: this.options.toolTimeoutMs ?? 120_000,
        maxReceiptChars: this.options.maxReceiptChars ?? 20_000,
        isAvailable: name => this.state === 'up' && this.available.has(name),
      })
      this.available = new Set(descriptors.map(tool => tool.name))
      await this.options.registerTools(tools)
      await this.options.notifyToolsChanged()
    }
    catch (error) {
      this.options.warn?.('airicraft tools could not be loaded', error)
    }
  }

  private async handOn(event: { seqNo: number, type: string, payload?: Record<string, unknown> }) {
    const delivery = deliveryFor(event.type, event.payload)
    if (delivery === 'archive')
      return

    await this.push({ type: `airicraft.${event.type}`, text: eventText(event), trigger: delivery, meta: { seqNo: event.seqNo } })
  }

  private notice(type: string, text: string) {
    return this.push({ type: `airicraft.${type}`, text: `[airicraft] ${text}`, trigger: 'flush' })
  }

  private async push(event: AgentEventInput) {
    try {
      await this.options.pushEvent(event)
    }
    catch (error) {
      this.options.warn?.('airicraft event was not accepted', error)
    }
  }
}
