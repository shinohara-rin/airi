import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'

import { getSpeechBusContext, voiceRequestSnapshot, voiceSnapshotChanged } from '../services/speech/bus'
import { useVoiceStore } from './voice'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale: { value: 'en' }, t: (key: string) => key }),
}))

/** Connects an output host and reports whether it answers a snapshot request of another window. */
async function answersSnapshotRequest(options: { windowOnly?: boolean }) {
  setActivePinia(createPinia())
  // No turn reaches this host, so the output factory never runs.
  const disconnect = useVoiceStore().connectOutput(() => {
    throw new Error('The test sends no turn')
  }, options)
  const bus = getSpeechBusContext()
  const snapshots: unknown[] = []
  const stop = bus.on(voiceSnapshotChanged, ({ body }) => snapshots.push(body))

  bus.emit(voiceRequestSnapshot, undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  stop()
  disconnect()
  return snapshots.length > 0
}

describe('useVoiceStore().connectOutput', () => {
  // Codex review on PR #30: a devtool host in a second window took commands that the main window host also took.
  it('serves other windows only when the host is not window-only', async () => {
    expect(await answersSnapshotRequest({})).toBe(true)
    expect(await answersSnapshotRequest({ windowOnly: true })).toBe(false)
  })
})
