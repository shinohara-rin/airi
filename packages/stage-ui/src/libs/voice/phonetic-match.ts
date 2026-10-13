import type { PhoneticVocabularyEntry } from './phonetic-vocabulary'

import { merge } from '@moeru/std'

/** One possible mishearing that the conversation model can accept or ignore. The transcript itself never changes. */
export interface PhoneticSuggestion {
  /** The transcript text that sounds like the term. */
  readonly span: string
  /** The written form that the speaker probably meant. */
  readonly candidate: string
  readonly term: string
  /** Phonetic similarity from 0 to 1. It is a ranking value, not a calibrated probability. */
  readonly score: number
  readonly source: string
  readonly description: string
}

/** One sound unit of the transcript, for example a Mandarin syllable or a Japanese mora. */
export interface PhoneticUnit {
  readonly tokens: readonly string[]
  /** UTF-16 offsets of the unit's characters in the transcript. */
  readonly start: number
  readonly end: number
}

/**
 * Converts one language between text and tokens, and prices token substitutions for that language.
 *
 * The matcher is shared. Each language owns only its tokenizer and its cost table, so a Korean jamo or a Japanese
 * kana adapter plugs in without a change to the matcher.
 */
export interface PhoneticLanguage {
  /** Splits transcript text into runs of units. A match window never crosses two runs. */
  units: (text: string) => PhoneticUnit[][]
  /**
   * The transcript window sizes, in units, that can sound like a vocabulary pronunciation.
   * Returns `undefined` when the pronunciation uses tokens of another language, or is too short to match safely.
   */
  windows: (tokens: readonly string[]) => { readonly min: number, readonly max: number } | undefined
  /** The cost from 0 to 1 of hearing token `a` for token `b`. Insertions and deletions cost 1. */
  substitutionCost: (a: string, b: string) => number
}

export interface PhoneticMatchOptions {
  /**
   * The lowest similarity that becomes a suggestion.
   * With six Mandarin tokens, one unrelated initial and one tone change score 0.82, so `流氓怪` still reaches `硫方怪`.
   * @default 0.78
   */
  threshold: number
  /**
   * The most suggestions for one transcript. The conversation model reads every one, so a long list costs attention.
   * @default 3
   */
  limit: number
}

const defaultOptions: PhoneticMatchOptions = { threshold: 0.78, limit: 3 }

/** Weighted edit distance, normalized to a similarity from 0 to 1. */
function similarity(heard: readonly string[], expected: readonly string[], substitutionCost: PhoneticLanguage['substitutionCost']) {
  let previous = Array.from({ length: expected.length + 1 }, (_, index) => index)
  for (let i = 1; i <= heard.length; i++) {
    const current = [i]
    for (let j = 1; j <= expected.length; j++)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + substitutionCost(heard[i - 1], expected[j - 1]))
    previous = current
  }
  return 1 - previous[expected.length] / Math.max(heard.length, expected.length)
}

/**
 * Creates a matcher that compares every unit n-gram of a transcript with every vocabulary pronunciation.
 *
 * The matcher checks each phrase, not only text that looks wrong, because a mishearing is often a plausible word,
 * for example `流氓怪` for `硫方怪`. Each language chooses the window sizes for a pronunciation, so a dropped or an
 * extra unit still matches.
 *
 * Each language reads only the pronunciations in its own tokens. Mixed-language phrases do not match.
 *
 * Returns suggestions with the highest score first. Spans do not overlap, and a span that already contains a written
 * form of the term is not suggested.
 */
export function createPhoneticMatcher(entries: readonly PhoneticVocabularyEntry[], languages: readonly PhoneticLanguage[], options?: Partial<PhoneticMatchOptions>) {
  const { threshold, limit } = merge(defaultOptions, options)
  const plans = languages.map(language => ({
    language,
    targets: entries.flatMap(entry => entry.pronunciations.flatMap((tokens) => {
      const windows = language.windows(tokens)
      return windows ? [{ entry, tokens, windows }] : []
    })),
  })).filter(plan => plan.targets.length)

  return (text: string): PhoneticSuggestion[] => {
    const found: (PhoneticSuggestion & { start: number, end: number })[] = []
    for (const { language, targets } of plans) {
      for (const run of language.units(text)) {
        for (const target of targets) {
          for (let size = target.windows.min; size <= target.windows.max; size++) {
            for (let first = 0; first + size <= run.length; first++) {
              const window = run.slice(first, first + size)
              const start = window[0].start
              const end = window.at(-1)!.end
              const span = text.slice(start, end)
              if (target.entry.writtenForms.some(form => span.includes(form)))
                continue
              const score = similarity(window.flatMap(unit => unit.tokens), target.tokens, language.substitutionCost)
              if (score < threshold)
                continue
              const { term, description, source, writtenForms } = target.entry
              found.push({ span, candidate: writtenForms[0] ?? term, term, score: Math.round(score * 100) / 100, source, description, start, end })
            }
          }
        }
      }
    }

    // The best match claims its span first. A weaker match of the same audio is another reading, not another term.
    const chosen: typeof found = []
    for (const match of found.sort((a, b) => b.score - a.score)) {
      if (chosen.length >= limit)
        break
      if (chosen.some(other => match.start < other.end && other.start < match.end))
        continue
      chosen.push(match)
    }
    return chosen.map(({ start: _start, end: _end, ...suggestion }) => suggestion)
  }
}
