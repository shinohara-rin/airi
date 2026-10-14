import type { EffectScope } from 'vue'

import { errorMessageFrom } from '@moeru/std'
import { BrowserPlayback } from '@proj-airi/audio/browser'
import { Playback } from '@proj-airi/pipelines-audio'
import { useVoiceListening } from '@proj-airi/stage-ui/composables/voice-input-mode'
import { useVoiceResponseOutput } from '@proj-airi/stage-ui/composables/voice-response-output'
import { getSpeechBusContext, voiceRequestSnapshot, voiceSnapshotChanged } from '@proj-airi/stage-ui/services/speech/bus'
import { useAudioContext, useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { listensContinuously, useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings/audio-device'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { computed, effectScope, onScopeDispose, ref, shallowRef, watch } from 'vue'

/**
 * Time in which the voice host of another window answers a snapshot request.
 * A busy or hidden window answered after about 900 ms in Chromium, so the wait is longer than that.
 */
const HOST_PROBE_MS = 1500

/**
 * Asks the speech bus for a voice host. This page answers only while its own host runs, and the probe runs before
 * that, so a connected answer comes from another window, for example the main window of the desktop app.
 */
async function findOtherHost() {
  const bus = getSpeechBusContext()
  const answer = Promise.withResolvers<boolean>()
  const stopListening = bus.on(voiceSnapshotChanged, ({ body }) => {
    if (body?.connected)
      answer.resolve(true)
  })
  const timer = setTimeout(() => answer.resolve(false), HOST_PROBE_MS)
  bus.emit(voiceRequestSnapshot, undefined)
  try {
    return await answer.promise
  }
  finally {
    stopListening()
    clearTimeout(timer)
  }
}

export type LiveVoiceHost = ReturnType<typeof useLiveVoiceHost>

/**
 * Makes this page the voice host while it runs: the microphone listens as the Hearing input mode says, and replies
 * of the active chat play here.
 *
 * The stage scene is the voice host on the main page. A route without the stage has no host, so this page starts one.
 * The host starts only on request, and not while another window is the voice host, because two listening hosts
 * answer each turn twice.
 * Special tokens, such as emotions, are not played, because the page has no character.
 * Scope disposal stops the host.
 */
export function useLiveVoiceHost() {
  const { audioContext } = useAudioContext()
  const speaking = useSpeakingStore()
  const speechOutputControl = useSpeechOutputControlStore()
  const hearing = useHearingStore()
  const devices = useSettingsAudioDevice()

  const scope = shallowRef<EffectScope>()
  const starting = ref(false)
  const error = ref<string>()
  let disposed = false

  async function start() {
    if (scope.value || starting.value)
      return

    error.value = undefined
    // Browsers resume a suspended context only during a user gesture, so the reply can play later.
    void audioContext.resume()
    starting.value = true
    try {
      if (await findOtherHost()) {
        error.value = 'Another window is the voice host, for example the main window of the desktop app. Both would answer each turn, so live turns run only where this page is the only host.'
        return
      }
    }
    finally {
      starting.value = false
    }
    // The page can close during the probe. A host started then has no owner to stop it.
    if (disposed)
      return

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

  onScopeDispose(() => {
    disposed = true
    stop()
  })

  /** The host listens to the microphone all the time, so it takes any speech that another recorder on the page hears as a turn. */
  const takesSpeech = computed(() => !!scope.value && devices.enabled && listensContinuously(hearing.inputMode))

  return { running: computed(() => !!scope.value), takesSpeech, starting, error, start, stop }
}
