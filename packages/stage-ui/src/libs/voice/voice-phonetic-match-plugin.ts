import type { VoicePlugin } from '@proj-airi/core-agent'

import type { PhoneticSuggestion } from './phonetic-match'
import type { PhoneticVocabularyEntry } from './phonetic-vocabulary'

/** Context key of the published suggestions. The chat prompt reads it through the submission context. */
export const PHONETIC_SUGGESTIONS_KEY = 'suggestions'

/**
 * The value that the conversation model reads. The note travels with the items, because the model sees only the
 * serialized submission context, not this module.
 */
export interface PhoneticSuggestions {
  readonly note: string
  readonly items: readonly PhoneticSuggestion[]
}

const NOTE = 'Speech recognition can mishear these spans. Each candidate sounds similar. The transcript is unchanged. Use a candidate only when the conversation supports it.'

export interface VoicePhoneticMatchOptions {
  /**
   * Reads the domain vocabulary when an input starts. An empty list installs no work for the input.
   * Return the same array until the vocabulary changes, so the matcher is not rebuilt for each input.
   */
  vocabulary: () => readonly PhoneticVocabularyEntry[]
  /**
   * The longest time matching can delay submission. After it, the input submits without suggestions.
   * @default 1000
   */
  timeoutMs?: number
}

/**
 * Publishes phonetic matches of the final transcript against a domain vocabulary.
 *
 * The plugin never patches the transcript. A false match then costs only a line of context, and the conversation model
 * decides with the description of each matched term. Descriptions of unmatched terms never reach the model.
 * Interim text is not matched, because the provider can still revise it.
 *
 * The matcher and its pinyin dictionary load on the first input with a vocabulary, so hosts without one do not load it.
 *
 * Use when:
 * - Install it on a controller. It needs no grant.
 *
 * Returns:
 * - A voice plugin named `voice-phonetic-match`. It publishes {@link PhoneticSuggestions} under {@link PHONETIC_SUGGESTIONS_KEY}.
 */
export function createVoicePhoneticMatchPlugin(options: VoicePhoneticMatchOptions): VoicePlugin {
  const timeoutMs = options.timeoutMs ?? 1000
  /** One matcher per vocabulary array. A new array from `vocabulary()` replaces it on the next input. */
  let cached: { entries: readonly PhoneticVocabularyEntry[], match: Promise<(text: string) => PhoneticSuggestion[]> } | undefined

  function matcherFor(entries: readonly PhoneticVocabularyEntry[]) {
    if (cached?.entries !== entries)
      cached = { entries, match: import('./phonetic-match').then(module => module.createPhoneticMatcher(entries)) }
    return cached.match
  }

  return {
    name: 'voice-phonetic-match',
    setup(scope) {
      scope.onSpeechInput((input) => {
        const entries = options.vocabulary()
        if (!entries.length)
          return undefined

        input.subscribe({ transcript: 'raw', scheduling: 'latest', timeoutMs, waitForSubmissionMs: timeoutMs }, async (ctx) => {
          const { segments, text } = ctx.snapshot.transcript
          if (!segments.length || segments.some(segment => !segment.final) || !text.trim())
            return

          const match = await matcherFor(entries)
          ctx.signal.throwIfAborted()
          const items = match(text)
          if (items.length)
            ctx.context.set<PhoneticSuggestions>(PHONETIC_SUGGESTIONS_KEY, { note: NOTE, items })
          else
            ctx.context.delete(PHONETIC_SUGGESTIONS_KEY)
        })
        return undefined
      })
      return undefined
    },
  }
}
