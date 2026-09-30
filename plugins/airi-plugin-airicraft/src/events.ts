import type { AgentEventTrigger } from '@proj-airi/plugin-sdk-tamagotchi/agent-events'

import type { BridgeEvent } from './bridge'

/** `archive` events are history only. The agent never sees them. */
export type Delivery = AgentEventTrigger | 'archive'

interface Rule {
  match: RegExp
  delivery: Delivery
}

/**
 * First match wins. Anything unmatched rides with the next wake (`piggyback`).
 * The table follows the mod's own attention rules: a reflex start preempts, direct chat and outcomes
 * flush, percepts debounce, and bookkeeping is archived.
 */
const RULES: readonly Rule[] = [
  { match: /^reflex\.started$/, delivery: 'preempt' },
  { match: /^(?:player\.died|player\.respawned|reflex\.resolved|reflex\.hold_released)$/, delivery: 'flush' },
  { match: /^(?:action_graph\.goal_terminal|action_graph\.goal_suspended|task\.(?:blocked|failed|completed))$/, delivery: 'flush' },
  { match: /^(?:smelting\.output_ready|session\.(?:world_loaded|world_unloaded|connection_lost))$/, delivery: 'flush' },
  { match: /^social\.player_addressed_agent$/, delivery: 'flush' },
  { match: /^(?:social\.player_spoke|social\.system_message|social\.item_offered|social\.player_(?:joined|left)_)/, delivery: 'debounce' },
  { match: /^(?:perception\.|combat\.damage_taken|pickup\.|crafting\.|follow\.)/, delivery: 'debounce' },
  { match: /^(?:action_graph\.|mission\.|planner\.|rules\.|policy\.event_intervened$|social\.local_controller_spoke$)/, delivery: 'archive' },
]

const FINAL_WORK_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

/** Decides how an event of this type wakes the agent, or that it does not reach the agent. */
export function deliveryFor(type: string, payload?: Record<string, unknown>): Delivery {
  // Work progress is frequent bookkeeping. Only a top-level job that reaches a final state is worth a wake.
  if (type === 'work.changed')
    return FINAL_WORK_STATES.has(String(payload?.state)) && !payload?.parentWorkId ? 'flush' : 'piggyback'

  // The mod announces its debug dashboard URL as a system message. That is noise for the agent.
  if (type === 'social.system_message' && /dashboard/i.test(JSON.stringify(payload ?? {})))
    return 'archive'

  return RULES.find(rule => rule.match.test(type))?.delivery ?? 'piggyback'
}

/** Fields shown for event types whose full payload is mostly internal detail. */
const SHOWN_FIELDS: Record<string, readonly string[]> = {
  'work.changed': ['label', 'state', 'phase', 'workId', 'parentWorkId'],
}

const MAX_VALUE_CHARS = 120
const MAX_TEXT_CHARS = 600

function render(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
}

/**
 * Event text states only what the mod reported: the type and its payload fields. Nothing is inferred.
 *
 * @example
 * eventText({ seqNo: 1, type: 'task.failed', payload: { reason: 'no path' } })
 * // => '[airicraft] task.failed reason=no path'
 */
export function eventText(event: BridgeEvent) {
  const shown = SHOWN_FIELDS[event.type]
  const fields = Object.entries(event.payload ?? {})
    .filter(([key]) => !shown || shown.includes(key))
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${render(value)}`)
  const text = `[airicraft] ${fields.length ? `${event.type} ${fields.join(' ')}` : event.type}`
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text
}
