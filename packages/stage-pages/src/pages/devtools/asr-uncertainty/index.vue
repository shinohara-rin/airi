<script setup lang="ts">
import type { AnalysisOptions, NucleusOptions, UncertainSpan, UntranscribedOptions } from '@proj-airi/stage-ui/libs/voice/asr-uncertainty'

import { errorMessageFrom } from '@moeru/std'
import { microphoneSource } from '@proj-airi/audio/browser'
import { fileSource, Pcm16Encoder, toFloat32FromPCM16, toWav } from '@proj-airi/audio/encoding'
import { xAsrBilingualZhEnInt8 } from '@proj-airi/provider-inference'
import { availableSherpawModels } from '@proj-airi/stage-ui/libs/providers/providers/sherpaw/model-resources'
import {
  analyzeHypotheses,
  defaultAnalysisOptions,
  defaultNucleusOptions,
  defaultUntranscribedOptions,
  findUntranscribedSpeech,
  formatForLlm,
  joinTokens,
  measureIntensity,
} from '@proj-airi/stage-ui/libs/voice/asr-uncertainty'
import { Button, Callout, FieldInputFile, FieldRange, FieldSelect, Progress } from '@proj-airi/ui'
import { useObjectUrl } from '@vueuse/core'
import { computed, onBeforeUnmount, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'

import UncertaintyTimeline from './components/uncertainty-timeline.vue'

import { useUncertaintyProbe } from './composables/use-uncertainty-probe'

/** Every Sherpaw model in AIRI runs at 16 kHz. Clips are converted to this rate once, when they load. */
const sampleRate = 16000

/** Clips longer than this make a run slow, because each decode takes about as long as the clip. */
const longClipSeconds = 12

const models = availableSherpawModels
const modelOptions = models.map(model => ({
  value: model.id,
  label: model.name,
  description: model.recognizer === 'paraformer' ? 'No token times. Only the text alignment works.' : 'Reports token times.',
}))
// X-ASR is the desktop default of Hearing for Chinese and English, and it reports token times.
const modelId = ref(models.find(model => model.id === xAsrBilingualZhEnInt8.id)?.id ?? models.find(model => model.recognizer === 'transducer')?.id ?? '')

const run = reactive({
  count: 12,
  snrMinDb: 8,
  snrMaxDb: 25,
  maxShiftMs: 40,
  speedSpreadPercent: 4,
  seed: 1,
  blankPenalty: 2,
})
const analysisOptions = reactive<AnalysisOptions>({ ...defaultAnalysisOptions })
const nucleusOptions = reactive<NucleusOptions>({ ...defaultNucleusOptions })
const untranscribedOptions = reactive<UntranscribedOptions>({ ...defaultUntranscribedOptions })

const clip = shallowRef<Float32Array<ArrayBuffer>>()
const clipError = ref<string>()
const files = ref<File[]>()
const recording = shallowRef<{ stop: () => void }>()

const clipSeconds = computed(() => (clip.value?.length ?? 0) / sampleRate)
const clipBlob = computed(() => clip.value ? new Blob([toWav(clip.value.buffer, sampleRate)], { type: 'audio/wav' }) : undefined)
const clipUrl = useObjectUrl(clipBlob)
const player = useTemplateRef<HTMLAudioElement>('player')

/**
 * Reads a PCM block stream to one mono clip at {@link sampleRate}.
 * `onReader` receives the encoder reader. Cancelling it ends the clip early, which stops a recording.
 */
async function readClip(frames: ConstructorParameters<typeof Pcm16Encoder>[0], signal: AbortSignal, onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void) {
  const reader = new Pcm16Encoder(frames, { sampleRate, signal }).stream.getReader()
  onReader?.(reader)
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    chunks.push(value)
    length += value.byteLength
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return toFloat32FromPCM16(bytes)
}

watch(files, async (selected) => {
  const file = selected?.[0]
  if (!file)
    return
  clipError.value = undefined
  try {
    // Nothing cancels a file read. The controller exists because both readers require a signal.
    const { signal } = new AbortController()
    clip.value = await readClip(fileSource(file).open(signal), signal)
  }
  catch (error) {
    clipError.value = errorMessageFrom(error) ?? 'Could not read the file.'
  }
})

function startRecording() {
  clipError.value = undefined
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  // Cancelling the encoder reader ends the read loop normally and closes the microphone connection.
  recording.value = { stop: () => void reader?.cancel() }
  readClip(microphoneSource({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).open(controller.signal), controller.signal, (created) => {
    reader = created
  })
    .then((samples) => {
      clip.value = samples
    })
    .catch((error) => {
      clipError.value = errorMessageFrom(error) ?? 'Could not record from the microphone.'
    })
    .finally(() => {
      recording.value = undefined
    })
}

const probe = useUncertaintyProbe()
const progressPercent = computed(() => probe.progress.value.total === 0 ? 0 : 100 * probe.progress.value.done / probe.progress.value.total)
const busy = computed(() => probe.status.value === 'loading' || probe.status.value === 'decoding')

function startProbe() {
  const model = models.find(candidate => candidate.id === modelId.value)
  if (!clip.value || !model)
    return
  const speedSpread = run.speedSpreadPercent / 100
  void probe.run(clip.value, {
    model,
    sampleRate,
    count: run.count,
    ranges: {
      snrDb: [Math.min(run.snrMinDb, run.snrMaxDb), Math.max(run.snrMinDb, run.snrMaxDb)],
      shiftMs: [0, run.maxShiftMs],
      speed: [1 - speedSpread, 1 + speedSpread],
    },
    seed: run.seed,
    blankPenalty: model.recognizer === 'transducer' ? run.blankPenalty : 0,
  })
}

/** Analysis reruns on every threshold change. The decodes stay as they are. */
const analysis = computed(() => {
  const result = probe.result.value
  if (!result)
    return undefined
  return analyzeHypotheses(result.reference, result.samples.map(sample => sample.hypothesis), result.durationSeconds, { ...analysisOptions })
})

/** Measured on the current clip. A new clip before a new run shows nuclei that do not match the result. */
const contour = computed(() => clip.value ? measureIntensity(clip.value, sampleRate, { ...nucleusOptions }) : undefined)

const spans = computed<UncertainSpan[]>(() => {
  const result = probe.result.value
  if (!result || !analysis.value || !contour.value)
    return []
  return [
    ...analysis.value.spans,
    ...findUntranscribedSpeech(contour.value, result.reference, { ...untranscribedOptions }, result.probe),
  ].toSorted((a, b) => (a.start ?? a.tokenStart) - (b.start ?? b.tokenStart))
})

const llmPreview = computed(() => probe.result.value ? formatForLlm(probe.result.value.reference, spans.value) : '')

function referenceText(span: UncertainSpan) {
  const tokens = probe.result.value?.reference.tokens.slice(span.tokenStart, span.tokenEnd) ?? []
  return joinTokens(tokens.map(token => token.text))
}

function play(seconds: number) {
  if (!player.value)
    return
  player.value.currentTime = Math.max(0, seconds)
  void player.value.play()
}

function agreementLabel(value: number | undefined) {
  return value === undefined ? '-' : value.toFixed(2)
}

onBeforeUnmount(() => recording.value?.stop())
</script>

<template>
  <div :class="['flex flex-col gap-6 pb-12']">
    <Callout label="What this measures">
      <p>
        The probe decodes the clip once as the reference, then many times with noise, a small time shift, and a small speed change.
        Tokens that the copies do not reproduce at the same audio time are unstable. Speech that the copies hear but the reference drops is a deletion.
        Syllable nuclei with no token near them are untranscribed speech. An elongated sound adds no nucleus, so it does not count.
      </p>
    </Callout>

    <section :class="['flex flex-col gap-4']">
      <h2 :class="['text-lg font-semibold']">
        Clip
      </h2>
      <div :class="['grid gap-4 md:grid-cols-2']">
        <FieldInputFile v-model="files" label="Audio file" description="Any format the browser can decode. It is converted to 16 kHz mono." accept="audio/*" />
        <div :class="['flex flex-col gap-2']">
          <div :class="['text-sm font-medium']">
            Microphone
          </div>
          <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
            Records without echo cancellation, noise suppression, or gain control, so the probe sees the raw input.
          </div>
          <div>
            <Button v-if="!recording" icon="i-solar:microphone-3-bold-duotone" label="Record" @click="startRecording" />
            <Button v-else icon="i-solar:stop-bold" color="red" label="Stop" @click="recording.stop()" />
          </div>
        </div>
      </div>
      <p v-if="clipError" :class="['text-sm text-red-500']">
        {{ clipError }}
      </p>
      <div v-if="clip" :class="['flex flex-wrap items-center gap-4 text-sm']">
        <audio ref="player" :src="clipUrl" controls />
        <span>{{ clipSeconds.toFixed(1) }} s</span>
        <span v-if="clipSeconds > longClipSeconds" :class="['text-amber-600 dark:text-amber-400']">
          Long clip. Each decode takes about as long as the clip, so trim it for faster runs.
        </span>
      </div>
    </section>

    <section :class="['flex flex-col gap-4']">
      <h2 :class="['text-lg font-semibold']">
        Run
      </h2>
      <FieldSelect v-model="modelId" label="Model" description="Downloads the model when it is not installed yet." :options="modelOptions" />
      <div :class="['grid gap-4 md:grid-cols-2']">
        <FieldRange v-model="run.count" label="Perturbed decodes" :min="2" :max="32" :step="1" />
        <FieldRange v-model="run.seed" label="Seed" description="The same seed repeats the same perturbations." :min="1" :max="100" :step="1" />
        <FieldRange v-model="run.snrMinDb" label="Lowest SNR" :min="0" :max="40" :step="1" :format-value="value => `${value} dB`" />
        <FieldRange v-model="run.snrMaxDb" label="Highest SNR" :min="0" :max="40" :step="1" :format-value="value => `${value} dB`" />
        <FieldRange v-model="run.maxShiftMs" label="Largest time shift" description="Moves the chunk boundaries of streaming models." :min="0" :max="200" :step="5" :format-value="value => `${value} ms`" />
        <FieldRange v-model="run.speedSpreadPercent" label="Speed spread" :min="0" :max="10" :step="0.5" :format-value="value => `±${value}%`" />
        <FieldRange
          v-model="run.blankPenalty"
          label="Blank penalty probe"
          description="One extra decode that emits more tokens. Its words fill untranscribed spans. 0 skips it. Transducers only."
          :min="0" :max="6" :step="0.5"
        />
      </div>
      <div :class="['flex flex-wrap items-center gap-4']">
        <Button variant="primary" color="primary" icon="i-solar:play-bold" label="Run probe" :disabled="!clip || busy || !modelId" @click="startProbe" />
        <Button v-if="busy" label="Stop" @click="probe.cancel()" />
        <span v-if="probe.status.value === 'loading'" :class="['text-sm']">Loading the model...</span>
        <span v-if="probe.status.value === 'decoding'" :class="['text-sm']">Decode {{ probe.progress.value.done }} of {{ probe.progress.value.total }}</span>
      </div>
      <Progress v-if="busy" :progress="progressPercent" />
      <p v-if="probe.error.value" :class="['text-sm text-red-500']">
        {{ probe.error.value }}
      </p>
    </section>

    <section v-if="probe.result.value && analysis && contour" :class="['flex flex-col gap-4']">
      <h2 :class="['text-lg font-semibold']">
        Result
      </h2>
      <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        Click the chart to play from that point. Span colors: amber is unstable, red is dropped, violet is untranscribed.
      </div>
      <UncertaintyTimeline
        :duration-seconds="probe.result.value.durationSeconds"
        :contour="contour"
        :tokens="analysis.tokens"
        :timeline="analysis.timeline"
        :spans="spans"
        :probe-tokens="probe.result.value.probe?.tokens"
        :agreement-threshold="analysisOptions.agreementThreshold"
        @seek="play"
      />

      <div :class="['flex flex-col gap-2']">
        <div :class="['text-sm font-medium']">
          What the LLM would read
        </div>
        <pre :class="['whitespace-pre-wrap rounded-lg p-3 text-sm', 'bg-neutral-100 dark:bg-neutral-800']">{{ llmPreview }}</pre>
      </div>

      <div :class="['flex flex-col gap-2']">
        <div :class="['text-sm font-medium']">
          Spans
        </div>
        <p v-if="spans.length === 0" :class="['text-sm text-neutral-500']">
          No spans at these thresholds.
        </p>
        <button
          v-for="(span, index) in spans"
          :key="index"
          type="button"
          :class="['flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg p-2 text-left text-sm', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700']"
          @click="play(span.start ?? 0)"
        >
          <span :class="['font-mono text-xs', { 'text-amber-600': span.kind === 'unstable', 'text-red-600': span.kind === 'dropped', 'text-violet-600': span.kind === 'untranscribed' }]">{{ span.kind }}</span>
          <span v-if="span.start !== undefined && span.end !== undefined" :class="['font-mono text-xs text-neutral-500']">{{ span.start.toFixed(2) }}-{{ span.end.toFixed(2) }} s</span>
          <span v-if="span.kind === 'unstable'">"{{ referenceText(span) }}"</span>
          <span :class="['text-neutral-500']">
            {{ span.variants.map(variant => `${variant.text || '(nothing)'} ×${variant.count}`).join(', ') }}
          </span>
        </button>
      </div>

      <details :class="['text-sm']">
        <summary :class="['cursor-pointer font-medium']">
          Thresholds
        </summary>
        <div :class="['grid gap-4 pt-4 md:grid-cols-2']">
          <FieldRange v-model="analysisOptions.toleranceSeconds" label="Same-text tolerance" :min="0.05" :max="0.6" :step="0.05" :format-value="value => `${value.toFixed(2)} s`" />
          <FieldRange v-model="analysisOptions.alignedToleranceSeconds" label="Aligned tolerance" description="An alignment match within this distance counts. It absorbs late emission." :min="0" :max="1.5" :step="0.05" :format-value="value => `${value.toFixed(2)} s`" />
          <FieldRange v-model="analysisOptions.agreementThreshold" label="Unstable below" :min="0.1" :max="1" :step="0.05" />
          <FieldRange v-model="analysisOptions.extraEmissionThreshold" label="Dropped from" :min="0.1" :max="1" :step="0.05" />
          <FieldRange v-model="nucleusOptions.minDipDb" label="Nucleus dip" description="Lower values split an elongated sound into several syllables." :min="1" :max="10" :step="0.5" :format-value="value => `${value} dB`" />
          <FieldRange v-model="untranscribedOptions.minNuclei" label="Untranscribed from" description="Unaccounted syllables in a row." :min="1" :max="5" :step="1" />
          <FieldRange v-model="untranscribedOptions.toleranceSeconds" label="Nucleus tolerance" :min="0.1" :max="0.6" :step="0.05" :format-value="value => `${value.toFixed(2)} s`" />
        </div>
      </details>

      <details :class="['text-sm']" open>
        <summary :class="['cursor-pointer font-medium']">
          Reference tokens
        </summary>
        <div :class="['flex flex-wrap gap-1 pt-2 font-mono text-xs']">
          <span
            v-for="(agreement, index) in analysis.tokens"
            :key="index"
            :title="`time ${agreement.token.time?.toFixed(2) ?? '-'} s, log p ${agreement.token.logProbability?.toFixed(2) ?? '-'}`"
            :class="['flex flex-col items-center rounded px-1', 'bg-neutral-100 dark:bg-neutral-800']"
          >
            <span>{{ agreement.token.text.replaceAll('▁', '·') }}</span>
            <span :class="['text-neutral-500']">{{ agreementLabel(agreement.byTime) }}</span>
            <span :class="['text-neutral-400']">{{ agreementLabel(agreement.byText) }}</span>
          </span>
        </div>
        <div :class="['pt-1 text-xs text-neutral-500']">
          Second line: agreement by audio time. Third line: agreement by text alignment only.
        </div>
      </details>

      <details :class="['text-sm']">
        <summary :class="['cursor-pointer font-medium']">
          Decodes
        </summary>
        <table :class="['mt-2 w-full text-left text-xs']">
          <thead>
            <tr :class="['text-neutral-500']">
              <th>SNR</th>
              <th>Shift</th>
              <th>Speed</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody :class="['font-mono']">
            <tr>
              <td colspan="3">
                reference
              </td>
              <td>{{ joinTokens(probe.result.value.reference.tokens.map(token => token.text)) }}</td>
            </tr>
            <tr v-for="(sample, index) in probe.result.value.samples" :key="index">
              <td>{{ sample.perturbation.snrDb.toFixed(1) }} dB</td>
              <td>{{ sample.perturbation.shiftMs.toFixed(0) }} ms</td>
              <td>{{ sample.perturbation.speed.toFixed(3) }}</td>
              <td>{{ joinTokens(sample.hypothesis.tokens.map(token => token.text)) }}</td>
            </tr>
            <tr v-if="probe.result.value.probe">
              <td colspan="3">
                blank penalty
              </td>
              <td>{{ joinTokens(probe.result.value.probe.tokens.map(token => token.text)) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: ASR Uncertainty Probe
  subtitleKey: tamagotchi.settings.devtools.title
</route>
