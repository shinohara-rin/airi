import type {} from 'pinia-plugin-synced'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

/** Who wakes the agent when the stage reports that a spoken reply finished or was cut off. */
export type SpeechEndTrigger = 'piggyback' | 'debounce' | 'flush'

/**
 * Settings of the event-driven agent loop. Each value is read when it is used, so a change takes effect
 * without a restart.
 */
export const useAgentLoopSettingsStore = defineStore('agent-loop-settings', () => {
  // Pinia synchronization owns live cross-window state. See the consciousness store for the same rule.
  const persistenceOptions = { listenToStorageChanges: false }

  /** Base interval of the quiet heartbeat in seconds. 0 turns it off. The interval doubles for each quiet beat, up to eight times. */
  const heartbeatSeconds = useLocalStorageManualReset<number>('settings/agent-loop/heartbeat-seconds', 0, persistenceOptions)

  /**
   * Waking on every speech end can double the request rate. `piggyback` lets the report ride with the next
   * wake, and it is the default for that reason.
   */
  const speechEndTrigger = useLocalStorageManualReset<SpeechEndTrigger>('settings/agent-loop/speech-end-trigger', 'piggyback', persistenceOptions)

  /** Tokens per window that debounce and heartbeat wakes may use before they wait for a chat message. 0 turns the guard off. */
  const spendGuardTokens = useLocalStorageManualReset<number>('settings/agent-loop/spend-guard-tokens', 2_000_000, persistenceOptions)
  const spendGuardWindowSeconds = useLocalStorageManualReset<number>('settings/agent-loop/spend-guard-window-seconds', 600, persistenceOptions)

  const heartbeatMs = computed(() => heartbeatSeconds.value > 0 ? heartbeatSeconds.value * 1000 : undefined)
  const spendGuard = computed(() => spendGuardTokens.value > 0
    ? { maxTokens: spendGuardTokens.value, windowMs: spendGuardWindowSeconds.value * 1000 }
    : undefined)

  return {
    heartbeatSeconds,
    speechEndTrigger,
    spendGuardTokens,
    spendGuardWindowSeconds,
    heartbeatMs,
    spendGuard,
  }
})
