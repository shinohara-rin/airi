import type { EffectScope } from 'vue'

import { errorMessageFrom } from '@moeru/std'
import { BrowserPlayback } from '@proj-airi/audio/browser'
import { Playback } from '@proj-airi/pipelines-audio'
import { useVoiceListening } from '@proj-airi/stage-ui/composables/voice-input-mode'
import { useVoiceResponseOutput } from '@proj-airi/stage-ui/composables/voice-response-output'
import { useAudioContext, useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { computed, effectScope, onScopeDispose, ref, shallowRef, watch } from 'vue'

/**
 * Makes this page the voice host while it runs: the microphone listens as the Hearing input mode says, and replies
 * of the active chat play here.
 *
 * The stage scene is the voice host on the main page. A route without the stage has no host, so this page starts one.
 * The host starts only on request, because a second window that listens too, as in the desktop app, answers twice.
 * Special tokens, such as emotions, are not played, because the page has no character.
 * Scope disposal stops the host.
 */
export function useLiveVoiceHost() {
  const { audioContext } = useAudioContext()
  const speaking = useSpeakingStore()
  const speechOutputControl = useSpeechOutputControlStore()

  const scope = shallowRef<EffectScope>()
  const error = ref<string>()

  function start() {
    if (scope.value)
      return

    error.value = undefined
    const created = effectScope(true)
    try {
      created.run(() => {
        const volume = audioContext.createGain()
        volume.connect(audioContext.destination)
        watch(() => speechOutputControl.speechVolume, (level) => {
          volume.gain.setTargetAtTime(level, audioContext.currentTime, 0.05)
        }, { immediate: true })

        let playing = 0
        const disconnect = useVoiceResponseOutput({
          audioContext,
          playback: new Playback(new BrowserPlayback(audioContext, { destination: volume })),
          onSpecial: () => {},
          onPlaybackStart: () => {
            playing += 1
            // Voice activity detection reads this, so the reply does not start an input of its own without echo cancellation.
            speaking.nowSpeaking = true
          },
          onPlaybackEnd: () => {
            playing -= 1
            if (playing === 0)
              speaking.nowSpeaking = false
          },
          onResponseStart: () => audioContext.resume(),
        })
        useVoiceListening()

        onScopeDispose(() => {
          disconnect()
          volume.disconnect()
          speaking.nowSpeaking = false
        })
      })
      scope.value = created
    }
    catch (cause) {
      created.stop()
      error.value = errorMessageFrom(cause) ?? 'The voice host could not start.'
    }
  }

  function stop() {
    scope.value?.stop()
    scope.value = undefined
  }

  onScopeDispose(stop)

  return { running: computed(() => !!scope.value), error, start, stop }
}
