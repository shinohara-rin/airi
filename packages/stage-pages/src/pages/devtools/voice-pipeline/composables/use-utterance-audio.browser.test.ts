import { describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'

import { useUtteranceAudio } from './use-utterance-audio'

const speaking = reactive({ nowSpeaking: false })

vi.mock('@proj-airi/stage-ui/stores/audio', () => ({ useSpeakingStore: () => speaking }))
vi.mock('@proj-airi/stage-ui/stores/voice', () => ({ useVoiceStore: () => ({ controller: { onInput: () => () => {} } }) }))

function setup() {
  const scope = effectScope(true)
  const audio = scope.run(() => useUtteranceAudio())!
  audio.utterances.set('input-1', { samples: new Float32Array(16000), sampleRate: 16000 })
  return { audio, dispose: () => scope.stop() }
}

describe('useUtteranceAudio', () => {
  // Codex review on PR #30: without echo cancellation, the host took the played utterance as a new turn.
  it('marks playback as speech until it stops', () => {
    const { audio, dispose } = setup()

    expect(audio.play('input-1')).toBe(true)
    expect(speaking.nowSpeaking).toBe(true)

    // A second playback replaces the first and keeps the flag.
    audio.play('input-1')
    expect(speaking.nowSpeaking).toBe(true)

    audio.stop()
    expect(speaking.nowSpeaking).toBe(false)
    dispose()
  })

  it('leaves the flag to a reply that already plays', () => {
    const { audio, dispose } = setup()
    speaking.nowSpeaking = true

    audio.play('input-1')
    audio.stop()

    expect(speaking.nowSpeaking).toBe(true)
    speaking.nowSpeaking = false
    dispose()
  })
})
