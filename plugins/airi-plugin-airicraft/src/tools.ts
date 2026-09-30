import type { PluginToolDefinition } from '@proj-airi/plugin-sdk-tamagotchi/tools'

import type { BridgeClient, ToolDescriptor } from './bridge'

import { BridgeError, BridgeUnreachable } from './bridge'

/**
 * Model-facing names start with this prefix, so they cannot collide with tools of other plugins.
 * The mod's own names are kept after it.
 */
export const TOOL_PREFIX = 'ac_'

/**
 * Tools of the mod's built-in planner. The agent owns speech, goals and wake policy, so these stay hidden.
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'say',
  'report_to_me',
  'update_event_policy',
  'record_decision',
  'set_planner_goal',
  'change_planner_goal',
  'finish_planner_goal',
  'block_planner_goal',
  'resume_planner_goal',
  'inspect_planner_goal',
])

const TOOL_NAME = /^[\w-]{1,64}$/

/**
 * Keeps a receipt small enough for the agent's context, and says so when it cuts.
 * For an external caller the mod's `observe` returns its whole recent event buffer on every call, around
 * 100 000 characters. Those events already reach the agent as events, so that list is replaced by a note.
 *
 * @example
 * shapeReceipt('observe', '{"current":"x","events":[1,2,3]}', 1000)
 * // => '{"current":"x","events":{"omitted":3,"note":"events are delivered to you as events; this list is left out"}}'
 */
export function shapeReceipt(name: string, text: string, maxChars: number) {
  let shaped = text
  if (name === 'observe') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (Array.isArray(parsed.events)) {
        parsed.events = { omitted: parsed.events.length, note: 'events are delivered to you as events; this list is left out' }
        shaped = JSON.stringify(parsed)
      }
    }
    catch {
      // A receipt that is not JSON only gets the length limit.
    }
  }

  return shaped.length > maxChars
    ? `${shaped.slice(0, maxChars)}\n[receipt cut: ${shaped.length - maxChars} more characters were left out]`
    : shaped
}

/** Optional parameters arrive as `null` because the plugin kit makes every parameter nullable. The mod expects them absent. */
function withoutNulls(input: unknown) {
  if (typeof input !== 'object' || input === null)
    return {}
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null))
}

export interface ToolContext {
  bridge: BridgeClient
  timeoutMs: number
  maxReceiptChars: number
  /** Whether the tool can be called now. Read by the host each time it lists tools. */
  isAvailable: (name: string) => boolean
}

/** Turns the mod's tool descriptors into plugin tool definitions that call back through the bridge. */
export function toToolDefinitions(descriptors: readonly ToolDescriptor[], context: ToolContext): PluginToolDefinition[] {
  return descriptors
    .filter(tool => !HIDDEN_TOOLS.has(tool.name) && TOOL_NAME.test(`${TOOL_PREFIX}${tool.name}`))
    .map(tool => ({
      id: `${TOOL_PREFIX}${tool.name}`,
      title: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      isAvailable: () => context.isAvailable(tool.name),
      execute: input => runTool(context, tool.name, withoutNulls(input)),
    }))
}

/** Failures come back as receipt text, so the agent can read what went wrong. */
async function runTool(context: ToolContext, name: string, args: Record<string, unknown>) {
  try {
    const result = await context.bridge.callTool(name, args, { timeoutMs: context.timeoutMs })
    const text = shapeReceipt(name, result.text, context.maxReceiptChars)
    return result.imageAttached ? `${text}\n[the mod attached an image, which is not shown here]` : text
  }
  catch (error) {
    if (error instanceof BridgeUnreachable)
      return `[${name} not run] the airicraft bridge is unreachable: ${error.message}`
    if (error instanceof BridgeError)
      return `[${name} rejected] ${error.code}: ${error.message}`
    throw error
  }
}
