import type { PhoneticVocabularyEntry } from './phonetic-vocabulary'

import { merge } from '@moeru/std'
import { pinyin } from 'pinyin-pro'

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

export interface PhoneticMatchOptions {
  /**
   * The lowest similarity that becomes a suggestion.
   * With six tokens, one unrelated initial and one tone change score 0.82, so `流氓怪` still reaches `硫方怪`.
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

/**
 * Substitution costs between tokens.
 *
 * ASR keeps the vowel shape of a syllable more often than its tone, so a tone change costs little.
 * The groups list pairs that Mandarin speakers and ASR models often merge, for example `l` and `n`, or `an` and `ang`.
 * Any other substitution, insertion, or deletion costs 1.
 */
const TONE_COST = 0.1
const CONFUSABLE_COST = 0.5
const confusableGroups = [['l', 'n', 'r'], ['f', 'h'], ['z', 'zh'], ['c', 'ch'], ['s', 'sh'], ['an', 'ang'], ['en', 'eng'], ['in', 'ing'], ['ian', 'iang'], ['uan', 'uang']]
const confusableGroup = new Map(confusableGroups.flatMap((group, index) => group.map(token => [token, index] as const)))

interface Syllable {
  readonly tokens: readonly string[]
  /** UTF-16 offsets of the syllable's characters in the transcript. */
  readonly start: number
  readonly end: number
}

/**
 * Removes tone marks, the `ü` diaeresis, and ARPAbet stress digits.
 * Pinyin libraries and the model vocabulary disagree on `ü` after `j`, `q`, `x`, and `y`, so the diaeresis is not a distinction here.
 *
 * @example
 * toneless('ǘ') // => 'u'
 * toneless('AY1') // => 'AY'
 */
function toneless(token: string) {
  return token.normalize('NFD').replace(/\p{M}/gu, '').replace(/\d$/, '')
}

/** A syllable has one vowel-bearing token: a pinyin final or an ARPAbet vowel with a stress digit. */
function countSyllables(tokens: readonly string[]) {
  return tokens.filter(token => /[aeiou]/i.test(toneless(token))).length
}

function substitutionCost(a: string, b: string) {
  if (a === b)
    return 0
  const baseA = toneless(a)
  const baseB = toneless(b)
  if (baseA === baseB)
    return TONE_COST
  const group = confusableGroup.get(baseA)
  return group !== undefined && group === confusableGroup.get(baseB) ? CONFUSABLE_COST : 1
}

/** Weighted edit distance, normalized to a similarity from 0 to 1. */
function similarity(heard: readonly string[], expected: readonly string[]) {
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
 * Splits text into runs of Chinese syllables, each as a pinyin initial and a toned final.
 * Any other character ends a run, so a match never crosses punctuation or another script.
 */
function syllableRuns(text: string): Syllable[][] {
  const runs: Syllable[][] = []
  let run: Syllable[] = []
  let offset = 0
  for (const item of pinyin(text, { type: 'all', toneType: 'symbol' })) {
    const start = offset
    offset += item.origin.length
    if (!item.isZh || !item.final) {
      if (run.length)
        runs.push(run)
      run = []
      continue
    }
    run.push({ tokens: item.initial ? [item.initial, item.final] : [item.final], start, end: offset })
  }
  if (run.length)
    runs.push(run)
  return runs
}

/**
 * Converts Chinese text to model tokens. Vocabulary packs use it when an entry has only written forms.
 *
 * @example
 * pronounceChinese('硫方怪')
 * // => ['l', 'iú', 'f', 'āng', 'g', 'uài']
 * pronounceChinese('Sulfur Cube')
 * // => undefined
 */
export function pronounceChinese(text: string): string[] | undefined {
  const runs = syllableRuns(text)
  if (runs.length !== 1 || runs[0].length !== [...text].length)
    return undefined
  return runs[0].flatMap(syllable => syllable.tokens)
}

/**
 * Creates a matcher that compares every syllable n-gram of a transcript with every vocabulary pronunciation.
 *
 * The matcher checks each phrase, not only text that looks wrong, because a mishearing is often a plausible word,
 * for example `流氓怪` for `硫方怪`. A window covers one syllable less to one syllable more than the pronunciation,
 * so a dropped or an extra syllable still matches. Pronunciations shorter than two syllables are skipped, because a
 * single syllable sounds like too many words.
 *
 * v1 reads only Chinese transcript text. English words and mixed Chinese and English phrases do not match yet.
 *
 * Returns suggestions with the highest score first. Spans do not overlap, and a span that already contains a written form of
 * the term is not suggested.
 */
export function createPhoneticMatcher(entries: readonly PhoneticVocabularyEntry[], options?: Partial<PhoneticMatchOptions>) {
  const { threshold, limit } = merge(defaultOptions, options)
  const targets = entries.flatMap(entry => entry.pronunciations.map(tokens => ({ entry, tokens, syllables: countSyllables(tokens) })))
    .filter(target => target.syllables >= 2)

  return (text: string): PhoneticSuggestion[] => {
    const found: (PhoneticSuggestion & { start: number, end: number })[] = []
    for (const run of syllableRuns(text)) {
      for (const target of targets) {
        for (let size = target.syllables - 1; size <= target.syllables + 1; size++) {
          for (let first = 0; first + size <= run.length; first++) {
            const window = run.slice(first, first + size)
            const start = window[0].start
            const end = window.at(-1)!.end
            const span = text.slice(start, end)
            if (target.entry.writtenForms.some(form => span.includes(form)))
              continue
            const score = similarity(window.flatMap(syllable => syllable.tokens), target.tokens)
            if (score < threshold)
              continue
            const { term, description, source, writtenForms } = target.entry
            found.push({ span, candidate: writtenForms[0] ?? term, term, score: Math.round(score * 100) / 100, source, description, start, end })
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
