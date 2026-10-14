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
