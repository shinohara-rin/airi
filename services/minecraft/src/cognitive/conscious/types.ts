export interface ContextViewState {
  selfSummary: string
  environmentSummary: string
}

export interface ChatMessage {
  sender: string
  content: string
  timestamp: number
}

export interface ActionHistoryLine {
  line: string
  timestamp: number
}

export interface BlackboardState {
  ultimateGoal: string
  currentTask: string
  strategy: string
  contextView: ContextViewState
  chatHistory: ChatMessage[]
  recentActionHistory: ActionHistoryLine[]
  pendingActions: string[]
  selfUsername: string
}
