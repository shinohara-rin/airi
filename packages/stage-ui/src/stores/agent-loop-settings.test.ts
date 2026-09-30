import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAgentLoopSettingsStore } from './agent-loop-settings'

describe('agent loop settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has no heartbeat by default and turns seconds into milliseconds when set', () => {
    const settings = useAgentLoopSettingsStore()
    expect(settings.heartbeatMs).toBeUndefined()

    settings.heartbeatSeconds = 30

    expect(settings.heartbeatMs).toBe(30_000)
  })

  it('guards spend by default and turns the guard off with zero tokens', () => {
    const settings = useAgentLoopSettingsStore()
    expect(settings.spendGuard).toEqual({ maxTokens: 2_000_000, windowMs: 600_000 })

    settings.spendGuardTokens = 0

    expect(settings.spendGuard).toBeUndefined()
  })

  it('lets speech end ride with the next wake by default', () => {
    expect(useAgentLoopSettingsStore().speechEndTrigger).toBe('piggyback')
  })
})
