import type { SherpawModel } from '@proj-airi/provider-inference'

import type { DecoderModel, LiveUpdate, RawSegment } from './events'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/webworkers'

import { fetchSherpawModelPack } from '../../providers/providers/sherpaw/model-assets'
import { decoderAccept, decoderDecode, decoderFinish, decoderListen, decoderLoad } from './events'

type WorkerContext = ReturnType<typeof createContext>['context']

/** Downloads the model pack when needed. One result can start many decoders. */
export async function fetchDecoderModel(model: SherpawModel): Promise<DecoderModel> {
  const pack = await fetchSherpawModelPack(model.id, `Sherpaw model "${model.id}"`)
  return { data: pack.data, metadata: pack.metadata, recognizer: model.recognizer, modelingUnit: model.modelingUnit }
}

/** Starts a decoder Worker and loads a copy of the model into it, so the caller keeps `model`. */
async function startWorker(model: DecoderModel) {
  const { default: DecoderWorker } = await import('./decoder.worker?worker')
  const worker = new DecoderWorker()
  try {
    const { context } = createContext(worker)
    const data = model.data.slice(0)
    await defineInvoke(context, decoderLoad)({ ...model, data }, { transfer: [data] })
    return { worker, context }
  }
  catch (error) {
    worker.terminate()
    throw error
  }
}

/**
 * Decodes whole clips with one Sherpaw model and keeps the raw sherpa-onnx results.
 *
 * Hearing's Sherpaw Provider keeps only text. This decoder keeps token times and log probabilities,
 * which the uncertainty probe needs. It owns one Worker. The Worker runs one decode at a time, in call
 * order. `dispose` terminates the Worker, and decodes that are still pending never settle.
 */
export class ClipDecoder {
  private readonly decodeInWorker

  private constructor(
    private readonly worker: Worker,
    context: WorkerContext,
  ) {
    this.decodeInWorker = defineInvoke(context, decoderDecode)
  }

  static async create(model: DecoderModel): Promise<ClipDecoder> {
    const { worker, context } = await startWorker(model)
    return new ClipDecoder(worker, context)
  }

  /** Decodes mono PCM in [-1, 1]. The samples are copied, so the caller keeps its array. */
  decode(samples: Float32Array, options: { sampleRate: number, blankPenalty: number }): Promise<RawSegment[]> {
    const copy = new Float32Array(samples)
    return this.decodeInWorker({ samples: copy, sampleRate: options.sampleRate, blankPenalty: options.blankPenalty }, { transfer: [copy.buffer] })
  }

  dispose(): void {
    this.worker.terminate()
  }
}

/**
 * Decodes one live input with the normal decoder and reports each segment that an endpoint closes.
 *
 * Token times count from the first accepted sample, also after an endpoint. Calls run in order in one
 * Worker. A decode slower than real time makes `accept` fall behind the input.
 */
export class LiveDecoder {
  private readonly acceptInWorker
  private readonly finishInWorker

  private constructor(
    private readonly worker: Worker,
    context: WorkerContext,
  ) {
    this.acceptInWorker = defineInvoke(context, decoderAccept)
    this.finishInWorker = defineInvoke(context, decoderFinish)
  }

  static async create(model: DecoderModel, sampleRate: number): Promise<LiveDecoder> {
    const { worker, context } = await startWorker(model)
    try {
      await defineInvoke(context, decoderListen)({ sampleRate })
      return new LiveDecoder(worker, context)
    }
    catch (error) {
      worker.terminate()
      throw error
    }
  }

  /** Decodes the next mono PCM block. The samples are copied, so the caller keeps its array. */
  accept(samples: Float32Array): Promise<LiveUpdate> {
    const copy = new Float32Array(samples)
    return this.acceptInWorker({ samples: copy }, { transfer: [copy.buffer] })
  }

  /** Ends the input. The result holds the last segment. */
  finish(): Promise<LiveUpdate> {
    return this.finishInWorker()
  }

  dispose(): void {
    this.worker.terminate()
  }
}
