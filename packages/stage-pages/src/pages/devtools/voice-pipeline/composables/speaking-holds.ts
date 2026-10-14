import { defineInvoke } from '@moeru/eventa'
import { getSpeechBusContext, speechOutputGetPlaybackState, speechOutputPlaybackStateChangedEvent } from '@proj-airi/stage-ui/services/speech/bus'
import { useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { onScopeDispose } from 'vue'

/**
 * Playbacks of this page that hold the speaking flag now.
 * The page is the only voice host of its window, so it owns the flag. The count lets playbacks overlap.
 */
let holds = 0

/**
 * Marks audio that this page plays as speech of the character until the returned function runs.
 *
 * Voice activity detection does not start an input while the character speaks, unless the microphone has echo
 * cancellation. So reply audio, a played turn, or a played clip does not become a new turn.
 * The flag stays set until every hold is released. A second call of the returned function does nothing.
 */
export function holdSpeaking(): () => void {
  const speaking = useSpeakingStore()
  holds += 1
  speaking.nowSpeaking = true
  let released = false
  return () => {
    if (released)
      return
    released = true
    holds -= 1
    if (holds === 0)
      speaking.nowSpeaking = false
  }
}

/**
 * Holds the speaking flag while one audio element plays. Bind `start` to its `play` event and `end` to its `pause`,
 * `ended`, and `emptied` events. Scope disposal releases the hold.
 */
export function useElementSpeakingHold() {
  let release: (() => void) | undefined

  function start() {
    release ??= holdSpeaking()
  }

  function end() {
    release?.()
    release = undefined
  }

  onScopeDispose(end)
  return { start, end }
}

/**
 * Holds the speaking flag while the output host of another window plays speech, for example a reply or read-aloud
 * in the main window. That audio comes out of the same speakers, so this page's listener must not take it as a turn.
 *
 * The first state comes from a request to that host, and later states from its change events. When no host answers
 * within one second, the flag waits for the next change event. Scope disposal releases the hold.
 * The page has no stage of its own. A stage in this window reports this page's own flag, so the hold would never end.
 */
export function useOtherWindowSpeakingHold() {
  const bus = getSpeechBusContext()
  let release: (() => void) | undefined
  let reported = false

  function follow(speaking: boolean) {
    if (speaking) {
      release ??= holdSpeaking()
      return
    }
    release?.()
    release = undefined
  }

  const stopChanges = bus.on(speechOutputPlaybackStateChangedEvent, ({ body }) => {
    if (!body)
      return
    reported = true
    follow(body.speaking)
  })
  let disposed = false
  defineInvoke(bus, speechOutputGetPlaybackState)(undefined, { signal: AbortSignal.timeout(1000) })
    .then((state) => {
      // A change event that arrived first is newer than this answer.
      if (!reported && !disposed)
        follow(state.speaking)
    })
    // No output host answered, for example in stage-web without a stage tab. Change events still arrive.
    .catch(() => {})

  onScopeDispose(() => {
    disposed = true
    stopChanges()
    follow(false)
  })
}
