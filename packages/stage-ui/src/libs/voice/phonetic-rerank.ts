import type { PhoneticCandidate } from './phonetic-match'

import { errorMessageFrom, merge } from '@moeru/std'

/**
 * A sentence embedding model with separate query and passage roles, for example multilingual E5.
 * Both methods return a unit vector, so the dot product is the cosine similarity.
 */
export interface SemanticEmbedder {
  embedQuery: (text: string) => Promise<readonly number[]>
  embedPassage: (text: string) => Promise<readonly number[]>
}

export interface SemanticRerankOptions {
  embedder: SemanticEmbedder
  /**
   * Reads the recent conversation when an input reranks, oldest message first.
   * The newest messages carry the topic, so the reranker keeps the end of this text when it is too long.
   */
  history: () => readonly string[]
  /**
   * How far meaning can move a candidate against its phonetic score.
   * A candidate gains `weight * (similarity - mean similarity of the pool)`.
   * With multilingual E5, a clear topic fit is about 0.05 above the mean, so the default moves it by about 0.2.
   * A near tie on sound then follows meaning, and a clear phonetic winner survives a weak topic signal.
   * @default 4
   */
  weight: number
  /**
   * The longest time that a rerank can wait for embeddings. After it, the candidates keep their phonetic order.
   * The first rerank also starts the model download, so it usually takes this path.
   * It must stay below the timeout of the phonetic match plugin, or the input submits without any suggestion.
   * @default 400
   */
  budgetMs: number
  /**
   * The most characters of history in the query. Small embedding models read about 512 tokens.
   * @default 1200
   */
  historyChars: number
}

const defaultOptions: Omit<SemanticRerankOptions, 'embedder' | 'history'> = { weight: 4, budgetMs: 400, historyChars: 1200 }

/** Replaces the heard span, so the query does not favor a term that only shares spelling with the mishearing. */
const MASK = '___'

function dot(a: readonly number[], b: readonly number[]) {
  let sum = 0
  for (let i = 0; i < a.length; i++)
    sum += a[i] * b[i]
  return sum
}

/**
 * Creates a `rerank` hook for the phonetic match plugin that orders candidates by meaning as well as by sound.
 *
 * Sound alone cannot choose between near ties, for example `reconciliation` and `recognition` for `resilation`.
 * For each heard span, the query is the recent conversation plus the transcript with that span masked.
 * Each candidate is a passage of its written form, its term, and its description.
 * The reranker moves each candidate by how much better than the pool average its passage fits the query.
 *
 * The reranker only reorders. It never drops a candidate, because the conversation model makes the final choice.
 * When the embeddings are not ready in {@link SemanticRerankOptions.budgetMs}, or the embedder fails, the candidates
 * keep their phonetic order. The embedding work continues in the background, so a later input can use the warm model.
 *
 * Passage embeddings are cached by passage text for the life of the reranker, because vocabulary entries repeat.
 */
export function createSemanticReranker(options: Pick<SemanticRerankOptions, 'embedder' | 'history'> & Partial<SemanticRerankOptions>) {
  const { embedder, history, ...tuning } = options
  const { weight, budgetMs, historyChars } = merge(defaultOptions, tuning)
  const passages = new Map<string, Promise<readonly number[]>>()

  function embedPassage(text: string) {
    let embedding = passages.get(text)
    if (!embedding) {
      embedding = embedder.embedPassage(text)
      // A failed embedding must not stay cached, or every later input fails on the same passage.
      embedding.catch(() => passages.delete(text))
      passages.set(text, embedding)
    }
    return embedding
  }

  async function score(text: string, candidates: readonly PhoneticCandidate[]) {
    const context = history().join('\n').slice(-historyChars)
    const queries = new Map<string, Promise<readonly number[]>>()
    const similarities = await Promise.all(candidates.map(async (candidate) => {
      const masked = `${text.slice(0, candidate.start)}${MASK}${text.slice(candidate.end)}`
      let query = queries.get(masked)
      if (!query) {
        query = embedder.embedQuery(context ? `${context}\n${masked}` : masked)
        queries.set(masked, query)
      }
      const label = candidate.candidate === candidate.term ? candidate.candidate : `${candidate.candidate} (${candidate.term})`
      const [queryEmbedding, passageEmbedding] = await Promise.all([query, embedPassage(`${label}: ${candidate.description}`)])
      return dot(queryEmbedding, passageEmbedding)
    }))

    const mean = similarities.reduce((sum, value) => sum + value, 0) / similarities.length
    return candidates
      .map((candidate, index) => ({ candidate, rank: candidate.score + weight * (similarities[index] - mean) }))
      .sort((a, b) => b.rank - a.rank)
      .map(({ candidate }) => candidate)
  }

  return async (request: { readonly text: string, readonly candidates: readonly PhoneticCandidate[] }, signal: AbortSignal): Promise<readonly PhoneticCandidate[]> => {
    // One candidate has nothing to reorder against.
    if (request.candidates.length < 2)
      return request.candidates

    const scored = score(request.text, request.candidates)
    let timer: ReturnType<typeof setTimeout> | undefined
    const fallback = new Promise<readonly PhoneticCandidate[]>((resolve) => {
      timer = setTimeout(resolve, budgetMs, request.candidates)
      signal.addEventListener('abort', () => resolve(request.candidates), { once: true })
    })
    try {
      // A failed embedding keeps the phonetic order, because the suggestions are still useful without meaning.
      const recovered = scored.catch((error) => {
        console.warn('[phonetic-rerank] Kept the phonetic order:', errorMessageFrom(error) ?? 'embedding failed')
        return request.candidates
      })
      return await Promise.race([recovered, fallback])
    }
    finally {
      clearTimeout(timer)
    }
  }
}
