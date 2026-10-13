import type { SemanticEmbedder } from './phonetic-rerank'

import { Mutex } from 'async-mutex'

/**
 * Multilingual E5 small, quantized for transformers.js. It reads Chinese and English in one vector space.
 * The q8 ONNX file is about 120 MB, and the browser Cache API keeps it after the first download.
 */
const MODEL_ID = 'Xenova/multilingual-e5-small'

/**
 * Embeds text with multilingual E5 in a browser Worker, through `@xsai-transformers/embed`.
 *
 * State:
 * - The Worker and the model load on the first embedding, not at construction.
 * - A failed load stays failed, so each later embedding rejects at once instead of starting another download.
 *   {@link dispose} clears it, and the next embedding loads again.
 * - Embeddings run one at a time, because the Worker holds one ONNX session.
 * - {@link dispose} terminates the Worker.
 *
 * E5 needs a `query: ` or `passage: ` prefix on each input. The two methods add it.
 */
export class MultilingualE5Embedder implements SemanticEmbedder {
  private provider: ReturnType<typeof loadProvider> | undefined
  private readonly queue = new Mutex()

  embedQuery(text: string) {
    return this.embed(`query: ${text}`)
  }

  embedPassage(text: string) {
    return this.embed(`passage: ${text}`)
  }

  dispose() {
    const provider = this.provider
    this.provider = undefined
    void provider?.then(loaded => loaded.terminateEmbed(), () => {})
  }

  private async embed(input: string): Promise<readonly number[]> {
    this.provider ??= loadProvider()
    const provider = await this.provider
    const { embed } = await import('@xsai/embed')
    return this.queue.runExclusive(async () => (await embed({ ...provider.embed(MODEL_ID), input })).embedding)
  }
}

/**
 * Creates the provider and waits for the model, so embed requests never start a load.
 * The provider and its Worker module load lazily, so hosts that never rerank do not load transformers.js.
 */
async function loadProvider() {
  const [{ createEmbedProvider }, { default: EmbedWorker }] = await Promise.all([
    import('@xsai-transformers/embed'),
    import('@xsai-transformers/embed/worker?worker'),
  ])
  const worker = new EmbedWorker()
  // `@xsai/embed` builds a request URL from `baseURL` before the provider's `fetch` answers it inside the Worker.
  const provider = createEmbedProvider({ baseURL: 'xsai-transformers:///', worker })

  // NOTICE:
  // A load never ends when the Worker fails to start, for example in the Vite dev server.
  // The eventa 0.3 adapter posts the `error` event to the Worker, which throws `DataCloneError`.
  // Source: @moeru/eventa@0.3.0 dist/adapters/webworkers/index.mjs, `worker.onerror`.
  // Removal condition: @xsai-transformers rejects a load when its Worker fails.
  const failed = new Promise<never>((_, reject) => {
    worker.addEventListener('error', event => reject(new Error(`Embedding Worker failed: ${event.message || 'the module did not load'}`)), { once: true })
  })

  try {
    // NOTICE:
    // The provider also loads the model inside each embed request. Two loads at once can mark the Worker ready too early.
    // `createTransformersWorker` in @xsai-transformers/shared 0.1.0 sets `isReady` when a second load sees `isLoading`.
    // Source: node_modules/@xsai-transformers/shared/dist/worker/index.js, `load`.
    // Removal condition: the shared worker awaits an in-flight load before it reports ready.
    await Promise.race([provider.loadEmbed(MODEL_ID), failed])
  }
  catch (error) {
    worker.terminate()
    throw error
  }
  return provider
}
