import type { BlackboardState, ChatMessage, ContextViewState } from './types'

export const MAX_CHAT_HISTORY = 8
export const MAX_ACTION_HISTORY = 12
export const MAX_PENDING_ACTIONS = 12

export function createBlackboard(initial?: Partial<BlackboardState>): BlackboardState {
  return {
    ultimateGoal: 'nothing',
    currentTask: 'I am waiting for something to happen.',
    strategy: 'idle',
    contextView: {
      selfSummary: 'Unknown',
      environmentSummary: 'Unknown',
    },
    chatHistory: [],
    recentActionHistory: [],
    pendingActions: [],
    selfUsername: 'Bot',
    ...initial,
  }
}

export function updateBlackboard(state: BlackboardState, patch: Partial<BlackboardState>): BlackboardState {
  return { ...state, ...patch }
}

export function updateContextView(state: BlackboardState, view: Partial<ContextViewState>): BlackboardState {
  return { ...state, contextView: { ...state.contextView, ...view } }
}

export function addChatMessage(state: BlackboardState, message: ChatMessage): BlackboardState {
  const newHistory = [...state.chatHistory, message]
  if (newHistory.length > MAX_CHAT_HISTORY)
    newHistory.shift()
  return { ...state, chatHistory: newHistory }
}

export function addActionHistoryLine(state: BlackboardState, line: string, timestamp = Date.now()): BlackboardState {
  const next = [...state.recentActionHistory, { line, timestamp }]
  const trimmed = next.length > MAX_ACTION_HISTORY ? next.slice(-MAX_ACTION_HISTORY) : next
  return { ...state, recentActionHistory: trimmed }
}

export function setPendingActions(state: BlackboardState, lines: string[]): BlackboardState {
  const trimmed = lines.length > MAX_PENDING_ACTIONS ? lines.slice(0, MAX_PENDING_ACTIONS) : lines
  return { ...state, pendingActions: trimmed }
}
