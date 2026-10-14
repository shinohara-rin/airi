import type { createEmbedProvider } from '@xsai-transformers/embed'

import type { SemanticEmbedder } from './phonetic-rerank'

import { errorMessageFrom } from '@moeru/std'
import { Mutex } from 'async-mutex'

/**
 * Multilingual E5 small, quantized for transformers.js. It reads Chinese and English in one vector space.
 * The q8 ONNX file is about 120 MB, and the browser Cache API keeps it after the first download.
 */
const MODEL_ID = 'Xenova/multilingual-e5-small'

type EmbedProvider = ReturnType<typeof createEmbedProvider>

/**
 * The state of one load of the Worker and the model. {@link MultilingualE5Embedder.dispose} marks it disposed.
 * `provider` is set as soon as the Worker exists, so a dispose during the download terminates it at once.
 */
interface LoadState {
  disposed: boolean
  provider?: EmbedProvider
}

/**
 * Embeds text with multilingual E5 in a browser Worker, through `@xsai-transformers/embed`.
 *
 * State:
 * - The Worker and the model load on the first embedding, not at construction.
 * - A failed load logs a warning, terminates its Worker, and stays failed, so each later embedding rejects at once instead of starting
 *   another 120 MB download. {@link dispose} clears it, and the next embedding loads again.
 * - Embeddings run one at a time, because the Worker holds one ONNX session. An embedding whose signal aborted while it
 *   waited in the queue does not run.
 * - {@link dispose} terminates the Worker, also while the model still downloads.
 *
 * E5 needs a `query: ` or `passage: ` prefix on each input. The two methods add it.
 */
export class MultilingualE5Embedder implements SemanticEmbedder {
  private load: { state: LoadState, ready: Promise<EmbedProvider> } | undefined
  private readonly queue = new Mutex()

  embedQuery(text: string, signal?: AbortSignal) {
    return this.embed(`query: ${text}`, signal)
  }

  embedPassage(text: string, signal?: AbortSignal) {
    return this.embed(`passage: ${text}`, signal)
  }

  dispose() {
    const load = this.load
    this.load = undefined
    if (!load)
      return
    load.state.disposed = true
    load.state.provider?.terminateEmbed()
  }

  private async embed(input: string, signal?: AbortSignal): Promise<readonly number[]> {
    if (!this.load) {
      const state: LoadState = { disposed: false }
      this.load = { state, ready: loadProvider(state) }
    }
    const provider = await this.load.ready
    const { embed } = await import('@xsai/embed')
    return this.queue.runExclusive(async () => {
      signal?.throwIfAborted()
      return (await embed({ ...provider.embed(MODEL_ID), input })).embedding
    })
  }
}

/**
 * Creates the provider and waits for the model, so embed requests never start a load.
 * The provider and its Worker module load lazily, so hosts that never rerank do not load transformers.js.
 * A Worker that fails to start rejects the load, because the eventa adapter aborts pending calls on `error`.
 */
async function loadProvider(state: LoadState): Promise<EmbedProvider> {
  const [{ createEmbedProvider }, { default: EmbedWorker }] = await Promise.all([
    import('@xsai-transformers/embed'),
    import('@xsai-transformers/embed/worker?worker'),
  ])
  if (state.disposed)
    throw new Error('Embedder was disposed')
  // `@xsai/embed` builds a request URL from `baseURL` before the provider's `fetch` answers it inside the Worker.
  const provider = createEmbedProvider({ baseURL: 'xsai-transformers:///', worker: new EmbedWorker() })
  state.provider = provider
  try {
    // NOTICE:
    // The provider also loads the model inside each embed request. Two loads at once can mark the Worker ready too early.
    // `createTransformersWorker` in @xsai-transformers/shared 0.2.0 sets `isReady` when a second load sees `isLoading`.
    // Source: node_modules/@xsai-transformers/shared/dist/worker/index.js, `load`.
    // Removal condition: the shared worker awaits an in-flight load before it reports ready.
    await provider.loadEmbed(MODEL_ID)
  }
  catch (error) {
    provider.terminateEmbed()
    // The reranker warns on each input, so this one warning names the cause and the way out.
    if (!state.disposed)
      console.warn('[multilingual-e5] The model did not load. Term suggestions keep the phonetic order until the setting is turned off and on again:', errorMessageFrom(error) ?? 'unknown error')
    throw error
  }
  if (state.disposed)
    throw new Error('Embedder was disposed')
  return provider
}
