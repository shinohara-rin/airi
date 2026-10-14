import type { EffectScope } from 'vue'

import { errorMessageFrom } from '@moeru/std'
import { BrowserPlayback } from '@proj-airi/audio/browser'
import { Playback } from '@proj-airi/pipelines-audio'
import { useVoiceListening } from '@proj-airi/stage-ui/composables/voice-input-mode'
import { claimListeningLease, useListeningLeasedElsewhere } from '@proj-airi/stage-ui/composables/voice-listening-lease'
import { useVoiceResponseOutput } from '@proj-airi/stage-ui/composables/voice-response-output'
import { useAudioContext, useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { listensContinuously, useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings/audio-device'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { computed, effectScope, onScopeDispose, ref, shallowRef, watch } from 'vue'

export type LiveVoiceHost = ReturnType<typeof useLiveVoiceHost>

/**
 * Makes this page the voice host while it runs: the microphone listens as the Hearing input mode says, and replies
 * of the active chat play here.
 *
 * The stage scene is the voice host on the main page. A route without the stage has no host, so this page starts one.
 * The host starts only on request. While it runs, it holds a listening lease, so the voice hosts of other windows,
 * for example the main window, stop listening. Two listening hosts would answer each turn twice.
 * It does not start while another window holds a lease, for example a second devtool window.
 * The output serves only this window, so a speech command of another window, such as read-aloud, plays once, on the
 * main window host.
 * Special tokens, such as emotions, are not played, because the page has no character.
 * Scope disposal stops the host.
 */
export function useLiveVoiceHost() {
  const { audioContext } = useAudioContext()
  const speaking = useSpeakingStore()
  const speechOutputControl = useSpeechOutputControlStore()
  const hearing = useHearingStore()
  const devices = useSettingsAudioDevice()

  const leasedElsewhere = useListeningLeasedElsewhere()

  const scope = shallowRef<EffectScope>()
  const error = ref<string>()

  function start() {
    if (scope.value)
      return

    error.value = undefined
    if (leasedElsewhere.value) {
      error.value = 'Another window runs its own voice host, for example a second devtool window. Stop it first, because both would answer each turn.'
      return
    }
    // Browsers resume a suspended context only during a user gesture, so the reply can play later.
    void audioContext.resume()

    const created = effectScope(true)
    try {
      created.run(() => {
        // The lease goes out before this page listens, so the other hosts stop first.
        onScopeDispose(claimListeningLease())
        const volume = audioContext.createGain()
        volume.connect(audioContext.destination)
        watch(() => speechOutputControl.speechVolume, (level) => {
          volume.gain.setTargetAtTime(level, audioContext.currentTime, 0.05)
        }, { immediate: true })

        let playing = 0
        const disconnect = useVoiceResponseOutput({
          audioContext,
          playback: new Playback(new BrowserPlayback(audioContext, { destination: volume })),
          windowOnly: true,
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

  /** The host listens to the microphone all the time, so it takes any speech that another recorder on the page hears as a turn. */
  const takesSpeech = computed(() => !!scope.value && devices.enabled && listensContinuously(hearing.inputMode))

  return { running: computed(() => !!scope.value), takesSpeech, error, start, stop }
}
