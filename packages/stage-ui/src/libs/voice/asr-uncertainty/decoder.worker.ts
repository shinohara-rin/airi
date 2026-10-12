import type { ASRModule, OnlineRecognizer } from '@sherpaw/asr'

import type { DecoderModel, RawSegment } from './events'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/webworkers/worker'
import { createOnlineRecognizer, initASRModule, OnlineRecognizerTypes } from '@sherpaw/asr'
import { loadData } from '@sherpaw/preloader'
import { array, number, object, optional, parse, string } from 'valibot'

import { decoderDecode, decoderLoad } from './events'

/**
 * The subset of the sherpa-onnx result JSON that the probe reads.
 * Source: `OnlineRecognizerResult::AsJsonString` in sherpa-onnx `csrc/online-recognizer.cc`.
 */
const resultSchema = object({
  text: string(),
  tokens: optional(array(string()), []),
  timestamps: optional(array(number()), []),
  ys_probs: optional(array(number()), []),
  start_time: optional(number(), 0),
})

/**
 * Streaming models hold back the last frames until more audio arrives. This much silence after the
 * clip flushes them, so the last word is decoded. The value matches the sherpa-onnx examples.
 */
const tailPaddingSeconds = 0.6

/** Feed size for one `acceptWaveform` call. The decoder result does not depend on it. */
const chunkSeconds = 0.1

const { context } = createContext()

/**
 * Worker state. `load` replaces all of it. Recognizers read model files from the module file system,
 * so each recognizer stays valid until the next `load`.
 */
let state: { module: ASRModule, model: DecoderModel, recognizers: Map<number, OnlineRecognizer> } | undefined

function recognizerFor(blankPenalty: number): OnlineRecognizer {
  if (!state)
    throw new Error('Load a model before decoding.')
  // The blank penalty is a recognizer setting, so each value needs its own recognizer.
  let recognizer = state.recognizers.get(blankPenalty)
  if (!recognizer) {
    recognizer = createOnlineRecognizer(state.module, {
      type: state.model.recognizer === 'paraformer' ? OnlineRecognizerTypes.Paraformer : OnlineRecognizerTypes.Transducer,
      modelConfig: { modelingUnit: state.model.modelingUnit },
      blankPenalty,
    })
    state.recognizers.set(blankPenalty, recognizer)
  }
  return recognizer
}

function readResult(recognizer: OnlineRecognizer, stream: ReturnType<OnlineRecognizer['createStream']>): RawSegment | undefined {
  const result = parse(resultSchema, recognizer.getResult(stream))
  if (result.text === '' && result.tokens.length === 0)
    return undefined
  return {
    text: result.text,
    tokens: result.tokens,
    timestamps: result.timestamps,
    ysProbs: result.ys_probs,
    startTime: result.start_time,
  }
}

defineInvokeHandler(context, decoderLoad, async (model) => {
  for (const recognizer of state?.recognizers.values() ?? [])
    recognizer.free()
  // A fresh module per load keeps an earlier model's files out of the file system.
  const module = await initASRModule()
  loadData({ module, metadata: model.metadata, data: model.data })
  state = { module, model, recognizers: new Map() }
  // Creating the default recognizer now reports a wrong model or recognizer type at load time.
  recognizerFor(0)
})

defineInvokeHandler(context, decoderDecode, ({ samples, sampleRate, blankPenalty }) => {
  const recognizer = recognizerFor(blankPenalty)
  const stream = recognizer.createStream()
  const segments: RawSegment[] = []
  try {
    const chunk = Math.round(sampleRate * chunkSeconds)
    const feed = (block: Float32Array) => {
      stream.acceptWaveform(sampleRate, block)
      while (recognizer.isReady(stream))
        recognizer.decode(stream)
      // An endpoint closes a segment. Reset starts the next one, so its result must be read first.
      if (recognizer.isEndpoint(stream)) {
        const segment = readResult(recognizer, stream)
        if (segment)
          segments.push(segment)
        recognizer.reset(stream)
      }
    }
    for (let start = 0; start < samples.length; start += chunk)
      feed(samples.subarray(start, start + chunk))
    feed(new Float32Array(Math.round(sampleRate * tailPaddingSeconds)))
    stream.inputFinished()
    while (recognizer.isReady(stream))
      recognizer.decode(stream)
    const last = readResult(recognizer, stream)
    if (last)
      segments.push(last)
    return segments
  }
  finally {
    stream.free()
  }
})
