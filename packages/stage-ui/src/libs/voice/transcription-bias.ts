import type { TranscriptionBias } from '@proj-airi/core-agent'

/**
 * Supplies phrases that a session's next speech recognition request prefers.
 *
 * The conversation is the first source. Memory can become a second source with the same contract.
 * Only terms that already appear for this session belong here. Guessed domain terms cause false insertions
 * in the recognizer, so they go to the post-recognition suggestions instead.
 */
export interface HotwordSource {
  readonly name: string
  /** Returns phrases, most relevant first. A rejection removes only this source from the next list. */
  collect: (sessionId: string, signal: AbortSignal) => Promise<readonly string[]>
}

interface ConversationMessage {
  readonly role: string
  readonly text: string
}

/**
 * Limits for conversation term extraction.
 *
 * Apple Speech accepts at most 100 contextual strings, so the default list fits it without a cut.
 */
const CONVERSATION_LIMITS = {
  /** Only the latest messages describe the current topic. */
  messages: 24,
  phrases: 100,
  /** A longer phrase is a sentence fragment, not a name. */
  phraseCharacters: 32,
  phraseWords: 4,
}

/** Capitalized words that start or fill sentences and name nothing. */
const COMMON_CAPITALIZED = new Set(['I', 'I\'m', 'I\'ll', 'I\'ve', 'I\'d', 'OK', 'Okay', 'Yes', 'No', 'Oh', 'Hi', 'Hello', 'Hey', 'Thanks', 'Sure'])

/** Spans that a writer marks as a name or a title, for example 「硫方怪」 or 《我的世界》. */
const QUOTED_SPAN = /[“「『《【"`]([^“”「」『』《》【】"`\n]{2,32})[”」』》】"`]/gu

/** Latin terms, with inner joiners such as `React.js`, `C++`, `C#`, and `gpt-4o`. */
const LATIN_TERM = /[A-Z][\w'+#-]*(?:\.[A-Z]\w*)*[+#]*/gi

/**
 * Collects names and rare terms that the conversation already contains, newest and most frequent first.
 *
 * A term qualifies when its written form marks it as specific. These forms are quoted or bracketed spans,
 * CamelCase or mixed-case words, acronyms, words with digits or joiners, and runs of capitalized words
 * inside a sentence. Plain lowercase words and CJK text outside quotes do not qualify, because
 * nothing in their form separates a name from ordinary speech.
 *
 * @example
 * collectConversationHotwords([{ role: 'user', text: 'I built a store with Zustand and React.js. Ask Sulfur Cube fans.' }])
 * // => ['Zustand', 'React.js', 'Sulfur Cube']
 */
export function collectConversationHotwords(messages: readonly ConversationMessage[], limit = CONVERSATION_LIMITS.phrases): string[] {
  const scores = new Map<string, { phrase: string, score: number, order: number }>()
  const recent = messages.filter(message => message.role === 'user' || message.role === 'assistant').slice(-CONVERSATION_LIMITS.messages)
  // A first pass finds the capitalized words that also appear inside a sentence. Only these can count at a sentence start.
  const names = new Set(recent.flatMap(message => termsOf(message.text, new Set())).flatMap(term => term.toLocaleLowerCase().split(' ')))
  let order = 0

  recent.forEach((message, index) => {
    // Newer messages weigh more. The newest message counts twice as much as the oldest one in the window.
    const weight = 1 + index / Math.max(1, recent.length - 1)
    for (const phrase of termsOf(message.text, names)) {
      const key = phrase.toLocaleLowerCase()
      const entry = scores.get(key)
      if (entry)
        entry.score += weight
      else
        scores.set(key, { phrase, score: weight, order: order++ })
    }
  })

  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, limit)
    .map(entry => entry.phrase)
}

function termsOf(text: string, names: ReadonlySet<string>): string[] {
  const terms: string[] = []
  for (const match of text.matchAll(QUOTED_SPAN)) {
    const span = match[1].trim()
    if (isPhrase(span))
      terms.push(span)
  }

  for (const sentence of text.split(/(?<=[.!?])\s+|(?<=[。！？\n])/u)) {
    let run: string[] = []
    const flush = () => {
      if (run.length && isPhrase(run.join(' ')))
        terms.push(run.join(' '))
      run = []
    }

    let previousEnd = 0
    for (const match of sentence.matchAll(LATIN_TERM)) {
      const word = match[0].replace(/[.'-]+$/, '')
      const start = match.index
      // A run of capitalized words breaks on anything but one space, for example a comma or a quote.
      if (sentence.slice(previousEnd, start) !== ' ')
        flush()
      previousEnd = start + match[0].length

      if (isSpecificForm(word)) {
        flush()
        terms.push(word)
        continue
      }
      // Grammar capitalizes the first word of a sentence, so a capital there marks a name only when
      // the same word also appears capitalized inside a sentence. A new name that opens a sentence,
      // such as "Sulfur Cube spawns", loses its first word.
      const sentenceStart = sentence.slice(0, start).trim() === ''
      if (/^[A-Z][a-z]/.test(word) && !COMMON_CAPITALIZED.has(word) && (!sentenceStart || names.has(word.toLocaleLowerCase()))) {
        run.push(word)
        continue
      }
      flush()
    }
    flush()
  }
  return terms
}

/** A written form that ordinary words do not have, such as `useMemo`, `ASR`, `x86`, `Node.js`, or `C++`. */
function isSpecificForm(word: string) {
  if (word.length < 2 || COMMON_CAPITALIZED.has(word))
    return false
  return /[a-z][A-Z]/.test(word)
    || /^[A-Z]{2,}s?$/.test(word)
    || (/\d/.test(word) && /[a-z]/i.test(word))
    || /[a-z][.+#]/i.test(word)
}

function isPhrase(value: string) {
  return value.length >= 2
    && value.length <= CONVERSATION_LIMITS.phraseCharacters
    && value.split(/\s+/).length <= CONVERSATION_LIMITS.phraseWords
    && !/[,.;:!?，。；：！？]$/u.test(value)
}

/**
 * Holds the prepared bias phrases of each session.
 *
 * State model:
 * - `lists` is a runtime cache, one list per session. A read returns the last finished rebuild, which can be
 *   one turn old. It is never computed on read, so speech start waits for no source.
 * - `pending` holds the rebuild in flight for each session. A new rebuild aborts the older one, so a slow
 *   source cannot overwrite a newer list.
 *
 * The owner calls {@link rebuild} after each assistant turn and when a session becomes active.
 * {@link dispose} aborts the rebuilds in flight and clears every list.
 */
export class TranscriptionBiasList {
  private readonly lists = new Map<string, TranscriptionBias>()
  private readonly pending = new Map<string, AbortController>()

  /**
   * @param sources Merged in this order. An earlier source wins a duplicate and keeps its place.
   * @param options Rebuild settings.
   * @param options.limit Total phrases for one session. @default 100
   * @param options.onError Receives the name and the error of a source that rejected.
   */
  constructor(
    private readonly sources: readonly HotwordSource[],
    private readonly options: { limit?: number, onError?: (source: string, error: unknown) => void } = {},
  ) {}

  /** Returns the last prepared bias of the session, or `undefined` before its first rebuild finishes. */
  read(sessionId: string): TranscriptionBias | undefined {
    return this.lists.get(sessionId)
  }

  /** Collects every source again and replaces the session's list. Superseded and disposed rebuilds change nothing. */
  async rebuild(sessionId: string): Promise<void> {
    this.pending.get(sessionId)?.abort('Superseded by a newer rebuild')
    const controller = new AbortController()
    this.pending.set(sessionId, controller)

    const results = await Promise.allSettled(this.sources.map(source => source.collect(sessionId, controller.signal)))
    if (controller.signal.aborted)
      return
    this.pending.delete(sessionId)

    const seen = new Set<string>()
    const phrases: string[] = []
    const limit = this.options.limit ?? CONVERSATION_LIMITS.phrases
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.options.onError?.(this.sources[index].name, result.reason)
        return
      }
      for (const phrase of result.value) {
        const key = phrase.trim().toLocaleLowerCase()
        if (!key || seen.has(key) || phrases.length >= limit)
          continue
        seen.add(key)
        phrases.push(phrase.trim())
      }
    })
    this.lists.set(sessionId, Object.freeze({ phrases: Object.freeze(phrases) }))
  }

  dispose() {
    for (const controller of this.pending.values())
      controller.abort('Bias list disposed')
    this.pending.clear()
    this.lists.clear()
  }
}
