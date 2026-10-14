import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { useClipReplay } from './use-clip-replay'

const devices = reactive({ input: { name: 'microphone' } as object, enabled: true })
const voice = {
  controller: {
    onInput: () => () => {},
    replaceAudio: vi.fn(),
  },
  beginManual: () => ({
    end: () => new Promise(() => {}),
    cancel: vi.fn(),
  }),
  startListening: vi.fn(),
  stopListening: vi.fn(async () => {}),
}

vi.mock('@proj-airi/stage-ui/stores/settings/audio-device', () => ({ useSettingsAudioDevice: () => devices }))
vi.mock('@proj-airi/stage-ui/stores/voice', () => ({ useVoiceStore: () => voice }))
vi.mock('@proj-airi/stage-ui/stores/chat/session-store', () => ({ useChatSessionStore: () => ({ activeSessionId: 'session' }) }))
vi.mock('@proj-airi/stage-ui/stores/modules/hearing', () => ({
  useHearingStore: () => ({ inputMode: 'push-to-talk' }),
  listensContinuously: () => false,
  startsInputOnSpeech: () => false,
}))

describe('useClipReplay', () => {
  // Codex review on PR #30: a microphone change replaced the replay source while the page still showed the replay.
  it('stops the replay when the microphone input changes', async () => {
    const { replay, replaying, error } = useClipReplay()
    const sampleRate = 16000
    const done = replay(new Float32Array(sampleRate * 2), sampleRate)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(replaying.value).toBeDefined()

    const microphone = { name: 'other microphone' }
    devices.input = microphone
    await done

    expect(replaying.value).toBeUndefined()
    expect(error.value).toBe('The microphone setting changed, so the replay stopped.')
    expect(voice.controller.replaceAudio).toHaveBeenLastCalledWith(microphone)
  })
})
