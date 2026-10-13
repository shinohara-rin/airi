import type { SherpawModelPack } from '../../providers/providers/sherpaw/model-assets'

import { defineInvokeEventa } from '@moeru/eventa'

/** A Sherpaw preload pack and the recognizer settings that read it. */
export interface DecoderModel {
  /** `preload.data`. Each worker gets its own copy. */
  readonly data: ArrayBuffer
  readonly metadata: SherpawModelPack['metadata']
  readonly recognizer: 'paraformer' | 'transducer'
  readonly modelingUnit: string
}

/**
 * One endpoint segment as sherpa-onnx reports it.
 *
 * Sherpaw's transcription worker keeps only `text`. The probe needs token times, so this worker keeps
 * the raw result. `tokens`, `timestamps`, and `ysProbs` have the same length when the model reports
 * times. Online Paraformer reports no times, so `timestamps` is empty for it.
 */
export interface RawSegment {
  readonly text: string
  readonly tokens: readonly string[]
  /** Seconds from `startTime`. */
  readonly timestamps: readonly number[]
  /** Log probability of each emitted token. Only transducers report it. */
  readonly ysProbs: readonly number[]
  /** Seconds from the start of the decoded audio to the start of this segment. */
  readonly startTime: number
}

export interface DecodeRequest {
  /** Mono PCM in [-1, 1]. The worker takes ownership, so the caller transfers its buffer. */
  readonly samples: Float32Array<ArrayBuffer>
  readonly sampleRate: number
  /**
   * Subtracted from the blank logit of a transducer. A positive value makes the decoder emit tokens
   * that it would otherwise drop, which exposes deleted speech. `0` is the normal decoder.
   */
  readonly blankPenalty: number
}

/** A segment that the live decoder closed, at an endpoint or at the end of the input. */
export interface LiveEndpoint {
  /** Has no tokens when the model heard nothing. The audio can still hold speech that the model deleted. */
  readonly segment: RawSegment
  /** Seconds from the first accepted sample to the end of the segment. */
  readonly endTime: number
}

export interface LiveUpdate {
  /** The open segment. Undefined when it has no tokens yet. */
  readonly partial?: RawSegment
  readonly endpoints: readonly LiveEndpoint[]
}

export interface LiveChunk {
  /** Mono PCM in [-1, 1] at the sample rate of `decoderListen`. The worker takes ownership. */
  readonly samples: Float32Array<ArrayBuffer>
}

export const decoderLoad = defineInvokeEventa<void, DecoderModel>('voice:asr-uncertainty:decoder:load')
export const decoderDecode = defineInvokeEventa<RawSegment[], DecodeRequest>('voice:asr-uncertainty:decoder:decode')
/** Opens the live stream. A second call drops the open stream and starts a new one. */
export const decoderListen = defineInvokeEventa<void, { sampleRate: number }>('voice:asr-uncertainty:decoder:listen')
export const decoderAccept = defineInvokeEventa<LiveUpdate, LiveChunk>('voice:asr-uncertainty:decoder:accept')
/** Flushes and closes the live stream. The result holds the last segment. */
export const decoderFinish = defineInvokeEventa<LiveUpdate, void>('voice:asr-uncertainty:decoder:finish')
