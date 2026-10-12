import type { SherpawModel } from '@proj-airi/provider-inference'
import type { Hypothesis, Perturbation, PerturbationRanges } from '@proj-airi/stage-ui/libs/voice/asr-uncertainty'

import { errorMessageFrom } from '@moeru/std'
import { cleanPerturbation, ClipDecoder, perturbAudio, samplePerturbations, toHypothesis } from '@proj-airi/stage-ui/libs/voice/asr-uncertainty'
import { onScopeDispose, ref, shallowRef } from 'vue'

/** Settings of one probe run. A run decodes `1 + count` copies of the clip, plus one probe decode when enabled. */
export interface ProbeSettings {
  readonly model: SherpawModel
  readonly sampleRate: number
  readonly count: number
  readonly ranges: PerturbationRanges
  readonly seed: number
  /** Blank penalty of the extra decode that exposes deleted speech. `0` skips that decode. */
  readonly blankPenalty: number
}

export interface ProbeSample {
  readonly perturbation: Perturbation
  readonly hypothesis: Hypothesis
}

export interface ProbeResult {
  readonly model: SherpawModel
  readonly durationSeconds: number
  readonly reference: Hypothesis
  readonly samples: readonly ProbeSample[]
  readonly probe?: Hypothesis
}

/**
 * Runs the Monte Carlo probe on one clip and keeps the last finished result.
 *
 * The decoder Worker stays alive between runs while the model stays the same, so a second run does not load
 * the model again. Starting a run stops the previous one after its current decode. Scope disposal terminates
 * the Worker.
 */
export function useUncertaintyProbe() {
  const status = ref<'idle' | 'loading' | 'decoding' | 'done' | 'error'>('idle')
  const progress = ref({ done: 0, total: 0 })
  const error = ref<string>()
  const result = shallowRef<ProbeResult>()

  let decoder: { modelId: string, instance: Promise<ClipDecoder> } | undefined
  /** Each run takes a new ID. A run whose ID is no longer current stops before its next decode. */
  let currentRun = 0

  function decoderFor(model: SherpawModel) {
    if (decoder?.modelId !== model.id) {
      const previous = decoder
      void previous?.instance.then(instance => instance.dispose(), () => {})
      decoder = { modelId: model.id, instance: ClipDecoder.create(model) }
      // A failed load must not stay cached, so the next run can retry.
      const created = decoder
      created.instance.catch(() => {
        if (decoder === created)
          decoder = undefined
      })
    }
    return decoder.instance
  }

  async function run(clip: Float32Array, settings: ProbeSettings) {
    const runId = ++currentRun
    const isCurrent = () => runId === currentRun
    const perturbations = samplePerturbations(settings.count, settings.ranges, settings.seed)
    progress.value = { done: 0, total: 1 + perturbations.length + (settings.blankPenalty > 0 ? 1 : 0) }
    error.value = undefined
    status.value = 'loading'

    try {
      const instance = await decoderFor(settings.model)
      if (!isCurrent())
        return
      status.value = 'decoding'

      const decode = async (perturbation: Perturbation, blankPenalty: number) => {
        const segments = await instance.decode(perturbAudio(clip, settings.sampleRate, perturbation), { sampleRate: settings.sampleRate, blankPenalty })
        progress.value = { ...progress.value, done: progress.value.done + 1 }
        return toHypothesis(segments, perturbation)
      }

      const reference = await decode(cleanPerturbation, 0)
      const samples: ProbeSample[] = []
      for (const perturbation of perturbations) {
        if (!isCurrent())
          return
        samples.push({ perturbation, hypothesis: await decode(perturbation, 0) })
      }
      const probe = settings.blankPenalty > 0 && isCurrent() ? await decode(cleanPerturbation, settings.blankPenalty) : undefined
      if (!isCurrent())
        return

      result.value = { model: settings.model, durationSeconds: clip.length / settings.sampleRate, reference, samples, probe }
      status.value = 'done'
    }
    catch (cause) {
      if (!isCurrent())
        return
      error.value = errorMessageFrom(cause) ?? 'The probe failed.'
      status.value = 'error'
    }
  }

  function cancel() {
    currentRun++
    status.value = result.value ? 'done' : 'idle'
  }

  onScopeDispose(() => {
    currentRun++
    void decoder?.instance.then(instance => instance.dispose(), () => {})
    decoder = undefined
  })

  return { status, progress, error, result, run, cancel }
}
