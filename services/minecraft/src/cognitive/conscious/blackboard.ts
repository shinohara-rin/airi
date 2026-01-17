import type { ActionHistoryLine, BlackboardState, ChatMessage, ContextViewState } from './types'
import * as Ops from './blackboard-ops'

export * from './types'
// Alias for backward compatibility
export type contextViewState = ContextViewState

export class Blackboard {
  private _state: BlackboardState

  constructor() {
    this._state = Ops.createBlackboard()
  }

  // Getters
  public get ultimate_goal(): string { return this._state.ultimateGoal }
  public get current_task(): string { return this._state.currentTask }
  public get strategy(): string { return this._state.strategy }
  public get selfSummary(): string { return this._state.contextView.selfSummary }
  public get environmentSummary(): string { return this._state.contextView.environmentSummary }
  public get chatHistory(): ChatMessage[] { return this._state.chatHistory }
  public get recentActionHistory(): ActionHistoryLine[] { return this._state.recentActionHistory }
  public get pendingActions(): string[] { return this._state.pendingActions }
  public get selfUsername(): string { return this._state.selfUsername }

  // Setters (using pure ops internally)
  public update(updates: Partial<BlackboardState>): void {
    this._state = Ops.updateBlackboard(this._state, updates)
  }

  public updateContextView(updates: Partial<ContextViewState>): void {
    this._state = Ops.updateContextView(this._state, updates)
  }

  public addChatMessage(message: ChatMessage): void {
    this._state = Ops.addChatMessage(this._state, message)
  }

  public addActionHistoryLine(line: string, timestamp: number = Date.now()): void {
    this._state = Ops.addActionHistoryLine(this._state, line, timestamp)
  }

  public setPendingActions(lines: string[]): void {
    this._state = Ops.setPendingActions(this._state, lines)
  }

  public getSnapshot(): BlackboardState {
    return {
      ...this._state,
      contextView: { ...this._state.contextView },
      chatHistory: [...this._state.chatHistory],
      recentActionHistory: [...this._state.recentActionHistory],
      pendingActions: [...this._state.pendingActions],
    }
  }
}
