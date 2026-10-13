import type { DecoderModel, RawSegment } from './events'

import { ClipDecoder } from './decoder'

/** The part of {@link ClipDecoder} that the pool uses. */
export type PooledDecoder = Pick<ClipDecoder, 'decode' | 'dispose'>

/**
 * Runs clip decodes on several decoders at the same time.
 *
 * Perturbed decodes do not depend on each other, so each decoder takes the next waiting decode when
 * it is free. Waiting decodes start in call order. Each decoder holds its own copy of the model, so
 * memory grows with the pool size.
 */
export class DecoderPool {
  private readonly idle: PooledDecoder[]
  private readonly waiting: ((decoder: PooledDecoder) => void)[] = []

  constructor(private readonly decoders: readonly PooledDecoder[]) {
    this.idle = [...decoders]
  }

  /** Starts `size` Worker decoders. When one fails to start, the others stop too. */
  static async create(model: DecoderModel, size: number): Promise<DecoderPool> {
    const results = await Promise.allSettled(Array.from({ length: size }, () => ClipDecoder.create(model)))
    const decoders = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const failure = results.find(result => result.status === 'rejected')
    if (failure) {
      for (const decoder of decoders)
        decoder.dispose()
      throw failure.reason
    }
    return new DecoderPool(decoders)
  }

  get size(): number {
    return this.decoders.length
  }

  /**
   * Decodes on the next free decoder. An abort removes a decode that still waits. A decode that already
   * runs finishes in its Worker, and its result is dropped.
   */
  async decode(samples: Float32Array, options: { sampleRate: number, blankPenalty: number }, signal?: AbortSignal): Promise<RawSegment[]> {
    signal?.throwIfAborted()
    const decoder = await this.acquire(signal)
    try {
      signal?.throwIfAborted()
      return await decoder.decode(samples, options)
    }
    finally {
      this.release(decoder)
    }
  }

  /** Terminates every decoder. Decodes that still wait or run never settle. */
  dispose(): void {
    this.waiting.length = 0
    for (const decoder of this.decoders)
      decoder.dispose()
  }

  private acquire(signal?: AbortSignal): Promise<PooledDecoder> {
    const free = this.idle.pop()
    if (free)
      return Promise.resolve(free)
    return new Promise((resolve, reject) => {
      const waiter = {
        take: (decoder: PooledDecoder) => {
          signal?.removeEventListener('abort', waiter.abort)
          resolve(decoder)
        },
        abort: () => {
          this.waiting.splice(this.waiting.indexOf(waiter.take), 1)
          reject(signal?.reason)
        },
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      this.waiting.push(waiter.take)
    })
  }

  private release(decoder: PooledDecoder) {
    const next = this.waiting.shift()
    if (next)
      next(decoder)
    else
      this.idle.push(decoder)
  }
}
