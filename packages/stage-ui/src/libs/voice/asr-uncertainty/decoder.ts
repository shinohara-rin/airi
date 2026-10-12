import type { SherpawModel } from '@proj-airi/provider-inference'

import type { RawSegment } from './events'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/webworkers'

import { fetchSherpawModelPack } from '../../providers/providers/sherpaw/model-assets'
import { decoderDecode, decoderLoad } from './events'

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
    context: ReturnType<typeof createContext>['context'],
  ) {
    this.decodeInWorker = defineInvoke(context, decoderDecode)
  }

  /** Downloads the model pack when needed, then starts a Worker with it. */
  static async create(model: SherpawModel): Promise<ClipDecoder> {
    const pack = await fetchSherpawModelPack(model.id, `Sherpaw model "${model.id}"`)
    const { default: DecoderWorker } = await import('./decoder.worker?worker')
    const worker = new DecoderWorker()
    try {
      const { context } = createContext(worker)
      await defineInvoke(context, decoderLoad)(
        { data: pack.data, metadata: pack.metadata, recognizer: model.recognizer, modelingUnit: model.modelingUnit },
        { transfer: [pack.data] },
      )
      return new ClipDecoder(worker, context)
    }
    catch (error) {
      worker.terminate()
      throw error
    }
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
