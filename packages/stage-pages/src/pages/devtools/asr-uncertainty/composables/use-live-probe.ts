import type { LiveUpdate, ProbeResult, SpeechSelectionOptions } from '@proj-airi/stage-ui/libs/voice/asr-uncertainty'

import type { ProbeDecoders } from './use-probe-decoders'
import type { ProbeRunSettings } from './use-uncertainty-probe'

import { errorMessageFrom } from '@moeru/std'
import { AudioHistory, fetchDecoderModel, LiveDecoder, normalizeToken, probeClip, selectSpeech } from '@proj-airi/stage-ui/libs/voice/asr-uncertainty'
import { onScopeDispose, ref, shallowRef } from 'vue'

export interface LiveSettings extends ProbeRunSettings {
  readonly selection: SpeechSelectionOptions
}

/** One segment of live speech and its probe. */
export interface LiveUtterance {
  readonly id: number
  /** Seconds from the start of the input to the start of the probed clip. */
  readonly start: number
  readonly end: number
  /** What the live decoder heard. The probe decodes the clip again for its reference. */
  readonly liveText: string
  readonly status: 'decoding' | 'done' | 'error'
  readonly progress: { done: number, total: number }
  readonly result?: ProbeResult
  readonly error?: string
  /** Seconds from the endpoint to the finished probe. */
  readonly latency?: number
}

/**
 * Decodes live input and probes each segment after its endpoint.
 *
 * One Worker decodes the input as it arrives and finds the endpoints. Each segment then goes to the
 * shared pool, so segments wait for each other there. A segment without tokens is probed only when it
 * has loud syllables, because it can hold speech that the model deleted.
 */
export function useLiveProbe(decoders: ProbeDecoders) {
  const status = ref<'idle' | 'loading' | 'listening' | 'error'>('idle')
  const partial = ref('')
  const error = ref<string>()
  const utterances = shallowRef<readonly LiveUtterance[]>([])

  /** `input` ends the audio input. `probes` also drops the probes that have not finished. */
  let session: { input: AbortController, probes: AbortController } | undefined

  function update(id: number, change: Partial<LiveUtterance>) {
    utterances.value = utterances.value.map(utterance => utterance.id === id ? { ...utterance, ...change } : utterance)
  }

  async function start(chunks: (signal: AbortSignal) => AsyncIterable<Float32Array>, settings: LiveSettings) {
    cancel()
    const current = { input: new AbortController(), probes: new AbortController() }
    session = current
    status.value = 'loading'
    error.value = undefined
    partial.value = ''
    utterances.value = []

    let decoder: LiveDecoder | undefined
    try {
      const [pool, created] = await Promise.all([
        decoders.poolFor(settings.model, settings.workers),
        fetchDecoderModel(settings.model).then(model => LiveDecoder.create(model, settings.sampleRate)),
      ])
      decoder = created
      if (session !== current)
        return
      status.value = 'listening'

      const history = new AudioHistory(settings.sampleRate)
      /** The loudest level of speech so far. It tells a deleted utterance from background noise. */
      let speechDb: number | undefined
      let nextId = 0

      const handle = ({ partial: open, endpoints }: LiveUpdate) => {
        partial.value = open?.text ?? ''
        for (const { segment, endTime } of endpoints) {
          const samples = history.slice(segment.startTime, endTime)
          // The next segment can start a little before this endpoint, because the decoder holds back
          // its last frames. Two seconds of history covers that.
          history.dropBefore(endTime - 2)
          const hasTokens = segment.tokens.some(token => normalizeToken(token) !== '')
          const selection = selectSpeech(samples, settings.sampleRate, hasTokens, speechDb, settings.selection)
          if (!selection)
            continue
          if (hasTokens)
            speechDb = Math.max(speechDb ?? Number.NEGATIVE_INFINITY, selection.loudDb)

          const id = nextId++
          const endpointAt = performance.now()
          utterances.value = [...utterances.value, {
            id,
            start: segment.startTime + selection.offset,
            end: endTime,
            liveText: segment.text,
            status: 'decoding',
            progress: { done: 0, total: 0 },
          }]
          const clip = samples.subarray(Math.round(selection.offset * settings.sampleRate))
          probeClip(pool, clip, settings, {
            signal: current.probes.signal,
            onProgress: (done, total) => update(id, { progress: { done, total } }),
          })
            .then(result => update(id, { status: 'done', result, latency: (performance.now() - endpointAt) / 1000 }))
            .catch((cause) => {
              if (!current.probes.signal.aborted)
                update(id, { status: 'error', error: errorMessageFrom(cause) ?? 'The probe failed.' })
            })
        }
      }

      for await (const samples of chunks(current.input.signal)) {
        history.append(samples)
        handle(await created.accept(samples))
        if (session !== current)
          return
      }
      handle(await created.finish())
      if (session === current)
        status.value = 'idle'
    }
    catch (cause) {
      if (session !== current)
        return
      error.value = errorMessageFrom(cause) ?? 'Live decoding failed.'
      status.value = 'error'
    }
    finally {
      decoder?.dispose()
    }
  }

  /** Ends the input. Segments that are already queued still finish. */
  function stop() {
    session?.input.abort()
  }

  /** Ends the input and drops the probes that have not finished. */
  function cancel() {
    session?.input.abort()
    session?.probes.abort()
    session = undefined
    status.value = 'idle'
  }

  onScopeDispose(cancel)

  return { status, partial, error, utterances, start, stop, cancel }
}
