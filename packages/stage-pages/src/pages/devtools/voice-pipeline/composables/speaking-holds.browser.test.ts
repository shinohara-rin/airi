import { createContext } from '@moeru/eventa/adapters/broadcast-channel'
import { BUS_CHANNEL_NAME, speechOutputPlaybackStateChangedEvent } from '@proj-airi/stage-ui/services/speech/bus'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'

import { holdSpeaking, useOtherWindowSpeakingHold } from './speaking-holds'

const speaking = reactive({ nowSpeaking: false })

vi.mock('@proj-airi/stage-ui/stores/audio', () => ({ useSpeakingStore: () => speaking }))

describe('useOtherWindowSpeakingHold', () => {
  // Codex review on PR #30: without echo cancellation, the devtool listener took the main window's reply as a turn.
  it('holds the speaking flag while the output host of another window speaks', async () => {
    const channel = new BroadcastChannel(BUS_CHANNEL_NAME)
    const otherWindow = createContext(channel).context
    const scope = effectScope(true)
    scope.run(() => useOtherWindowSpeakingHold())

    otherWindow.emit(speechOutputPlaybackStateChangedEvent, { speaking: true, voicing: true })
    await expect.poll(() => speaking.nowSpeaking).toBe(true)

    // A playback of this page keeps the flag after the other window stops.
    const release = holdSpeaking()
    otherWindow.emit(speechOutputPlaybackStateChangedEvent, { speaking: false, voicing: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(speaking.nowSpeaking).toBe(true)
    release()
    expect(speaking.nowSpeaking).toBe(false)

    // Scope disposal releases a hold that the other window still asks for.
    otherWindow.emit(speechOutputPlaybackStateChangedEvent, { speaking: true, voicing: true })
    await expect.poll(() => speaking.nowSpeaking).toBe(true)
    scope.stop()
    expect(speaking.nowSpeaking).toBe(false)
    channel.close()
  })
})
