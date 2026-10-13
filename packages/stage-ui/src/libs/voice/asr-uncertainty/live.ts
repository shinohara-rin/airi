import type { NucleusOptions } from './articulation'

import { measureIntensity } from './articulation'

/**
 * Keeps recent live audio, so a segment can be cut out after its endpoint.
 * Positions are seconds from the first appended sample.
 */
export class AudioHistory {
  private chunks: { start: number, samples: Float32Array }[] = []
  private appended = 0

  constructor(private readonly sampleRate: number) {}

  /** Seconds appended so far. */
  get duration(): number {
    return this.appended / this.sampleRate
  }

  append(samples: Float32Array): void {
    this.chunks.push({ start: this.appended, samples })
    this.appended += samples.length
  }

  /** Copies the audio from `start` to `end`. The copy starts later when `start` falls in dropped audio. */
  slice(start: number, end: number): Float32Array<ArrayBuffer> {
    const available = this.chunks[0]?.start ?? this.appended
    const from = Math.max(available, Math.round(start * this.sampleRate))
    const to = Math.min(this.appended, Math.round(end * this.sampleRate))
    const output = new Float32Array(Math.max(0, to - from))
    for (const chunk of this.chunks) {
      const begin = Math.max(from, chunk.start)
      const finish = Math.min(to, chunk.start + chunk.samples.length)
      if (begin < finish)
        output.set(chunk.samples.subarray(begin - chunk.start, finish - chunk.start), begin - from)
    }
    return output
  }

  /** Frees the chunks that end before `time`. */
  dropBefore(time: number): void {
    const position = Math.round(time * this.sampleRate)
    this.chunks = this.chunks.filter(chunk => chunk.start + chunk.samples.length > position)
  }
}

export interface SpeechSelection {
  /** Seconds from the segment start to the start of the speech, with a margin. */
  readonly offset: number
  /** The loudest level of this segment, in dBFS. Pass the highest one seen so far as `speechDb`. */
  readonly loudDb: number
}

export interface SpeechSelectionOptions {
  readonly nucleus: NucleusOptions
  /** Syllables that a segment without tokens needs before it counts as deleted speech. */
  readonly minNuclei: number
  /** Audio kept before the first loud frame, in seconds. @default 0.3 */
  readonly marginSeconds: number
}

/**
 * Finds where the speech of one live segment starts, or returns undefined when the segment holds none.
 *
 * A segment starts at the previous endpoint, so it can begin with a long pause. Cutting that pause
 * saves decode time. A segment whose reference has no tokens is either silence or speech that the
 * model deleted. It counts as speech only with `minNuclei` syllables louder than the silence level of
 * earlier speech, so `speechDb` must come from segments that had tokens.
 */
export function selectSpeech(samples: Float32Array, sampleRate: number, hasTokens: boolean, speechDb: number | undefined, options: SpeechSelectionOptions): SpeechSelection | undefined {
  const contour = measureIntensity(samples, sampleRate, options.nucleus)
  const loudDb = contour.silenceDb + options.nucleus.silenceRangeDb
  const reference = hasTokens ? Math.max(loudDb, speechDb ?? loudDb) : speechDb
  if (reference === undefined)
    return undefined
  const floorDb = reference - options.nucleus.silenceRangeDb

  if (!hasTokens) {
    const loudNuclei = contour.nuclei.filter(time => (contour.db[Math.round(time / contour.hopSeconds)] ?? Number.NEGATIVE_INFINITY) > floorDb)
    if (loudNuclei.length < options.minNuclei)
      return undefined
  }

  const firstLoud = contour.db.findIndex(value => value > floorDb)
  const offset = firstLoud < 0 ? 0 : Math.max(0, firstLoud * contour.hopSeconds - options.marginSeconds)
  return { offset, loudDb }
}
