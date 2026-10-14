<script setup lang="ts">
import type { IOSubsystem } from '@proj-airi/stage-shared'

import { useVoicePushToTalk } from '@proj-airi/stage-ui/composables/voice-input-mode'
import { getSpeechBusContext, voiceInputLevel } from '@proj-airi/stage-ui/services/speech/bus'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useIOTracerStore } from '@proj-airi/stage-ui/stores/devtools/io-tracer'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings/audio-device'
import { useVoiceStore } from '@proj-airi/stage-ui/stores/voice'
import { Button, Callout, FieldCheckbox, FieldInputFile, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'

import IOTracerChart from '../../io-tracer/components/io-tracer-chart.vue'

import { isSpokenTurn, voiceTurnLatency, voiceTurnTiming } from '../composables/turn-timing'
import { useClipInput } from '../composables/use-clip-input'
import { useClipReplay } from '../composables/use-clip-replay'
import { useLiveVoiceHost } from '../composables/use-live-voice-host'

/** The voice pipeline runs at 16 kHz, so a replayed clip is converted to it once, when it loads. */
const sampleRate = 16000

const voice = useVoiceStore()
const hearing = useHearingStore()
const devices = useSettingsAudioDevice()
const sessions = useChatSessionStore()
const { inputMode, autoSendEnabled } = storeToRefs(hearing)
const { enabled: microphoneEnabled } = storeToRefs(devices)

const host = useLiveVoiceHost()
const pushToTalk = useVoicePushToTalk()
const clip = useClipInput(sampleRate)
const replay = useClipReplay()

// Stopping the host cancels the input that a replay holds, so the replay stops with it and returns the microphone.
function stopHost() {
  replay.stop()
  host.stop()
}

const inputModeOptions = [
  { value: 'always-on', label: 'Always on', description: 'Voice activity detection starts and ends each input.' },
  { value: 'push-to-talk', label: 'Push to Talk', description: 'Hold the button below. A replayed clip holds it for its length.' },
  { value: 'wake-word', label: 'Wake word', description: 'A wake word starts the input. A replayed clip cannot wake, so it holds the input like Push to Talk.' },
]

const activeChat = computed(() => {
  const sessionId = sessions.activeSessionId
  if (!sessionId)
    return undefined
  return sessions.sessionMetas[sessionId]?.title || sessionId
})

const phase = computed(() => voice.state?.phase ?? 'idle')
const liveText = computed(() => voice.transcript?.transcript.text ?? '')

// The voice host publishes the level while an input captures from the microphone.
const level = ref(0)
onScopeDispose(getSpeechBusContext().on(voiceInputLevel, ({ body }) => {
  if (body)
    level.value = body.level
}))

// Timeline

const tracer = useIOTracerStore()
const { turns, selectedSpanId, recordingStartTs } = storeToRefs(tracer)
// The IO tracer page can be recording already, in another view of the same store. Only a recording that this view
// started stops with it.
const ownsRecording = !tracer.isRecording
tracer.startRecording()
onScopeDispose(() => {
  if (ownsRecording)
    tracer.stopRecording()
})
const hiddenSubsystems = shallowRef(new Set<IOSubsystem>())

const spokenTurns = computed(() => turns.value
  .filter(isSpokenTurn)
  .map((turn) => {
    const timing = voiceTurnTiming(turn)
    return { turn, timing, latency: voiceTurnLatency(timing) }
  })
  .reverse())

function formatMs(ms: number | undefined) {
  if (ms === undefined)
    return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString()
}

function selectTurn(turnId: string) {
  const turn = turns.value.find(candidate => candidate.id === turnId)
  tracer.selectSpan(turn?.spans[0]?.id ?? null)
}
</script>

<template>
  <section :class="['flex flex-col gap-4']">
    <h2 :class="['text-lg font-semibold']">
      Live turns
    </h2>
    <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
      Runs whole voice turns through the production pipeline: speech detection, recognition, the reply in the active chat, and speech output.
      The settings below are the Hearing settings of the app.
    </p>

    <div :class="['flex flex-wrap items-center gap-3']">
      <Button
        v-if="!host.running.value"
        variant="primary"
        icon="i-solar:play-bold"
        :label="host.starting.value ? 'Looking for another voice host...' : 'Start the voice host'"
        :disabled="host.starting.value"
        @click="host.start()"
      />
      <Button v-else icon="i-solar:stop-bold" label="Stop the voice host" @click="stopHost()" />
      <span v-if="host.running.value" :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        This page listens and plays the replies now. Leaving the page stops the host.
      </span>
    </div>
    <Callout v-if="host.error.value" theme="orange" label="The voice host could not start">
      <p>{{ host.error.value }}</p>
    </Callout>
    <Callout v-if="!hearing.configured" theme="orange" label="No Hearing provider">
      <p>Set up a transcription provider in the Hearing settings. Without it, speech starts no input.</p>
    </Callout>

    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldSelect v-model="inputMode" label="Input mode" :options="inputModeOptions" />
      <FieldCheckbox
        v-model="microphoneEnabled"
        label="Microphone input"
        description="The microphone stays open in Always on and Wake word mode. In Push to Talk mode, it opens only while you hold the button."
      />
      <FieldCheckbox
        v-model="autoSendEnabled"
        label="Send each turn to the chat"
        description="Off is a dry run: each turn stays a draft below, and you send or discard it."
      />
      <div :class="['flex flex-col gap-1 text-sm']">
        <div :class="['font-medium']">
          Active chat
        </div>
        <div :class="['text-neutral-500 dark:text-neutral-400']">
          {{ activeChat ?? 'No chat is active. Open a chat on the main page first.' }}
        </div>
      </div>
    </div>

    <div :class="['flex flex-wrap items-center gap-4']">
      <Button
        v-if="inputMode !== 'always-on'"
        icon="i-solar:microphone-3-bold-duotone"
        :label="pushToTalk.held.value ? 'Release to send' : 'Hold to talk'"
        :disabled="!host.running.value || !pushToTalk.enabled.value"
        @pointerdown="pushToTalk.press()"
        @pointerup="pushToTalk.release()"
        @pointerleave="pushToTalk.release()"
      />
      <div :class="['flex items-center gap-2 text-sm']">
        <span :class="['text-neutral-500 dark:text-neutral-400']">Input</span>
        <span :class="['font-mono']">{{ phase }}</span>
        <div :class="['h-2 w-24 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700']">
          <div :class="['h-full bg-primary-500 transition-all duration-100']" :style="{ width: `${Math.round(Math.min(1, level) * 100)}%` }" />
        </div>
      </div>
      <span v-if="liveText" :class="['text-sm']">{{ liveText }}</span>
    </div>

    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldInputFile
        v-model="clip.files.value"
        label="Clip to replay"
        description="Any format the browser can decode. The clip goes into the pipeline in real time, in place of the microphone."
        accept="audio/*"
      />
      <div :class="['flex flex-col gap-2']">
        <div :class="['text-sm font-medium']">
          Record a clip
        </div>
        <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          Records without echo cancellation, noise suppression, or gain control. Replay it to repeat the same turn.
        </div>
        <div>
          <Button v-if="!clip.recording.value" icon="i-solar:microphone-3-bold-duotone" label="Record" @click="clip.record" />
          <Button v-else icon="i-solar:stop-bold" color="red" label="Stop" @click="clip.stop" />
        </div>
      </div>
    </div>
    <p v-if="clip.error.value" :class="['text-sm text-red-500']">
      {{ clip.error.value }}
    </p>
    <div :class="['flex flex-wrap items-center gap-3']">
      <Button
        v-if="!replay.replaying.value"
        icon="i-solar:play-bold"
        label="Replay the clip"
        :disabled="!host.running.value || !clip.clip.value"
        @click="replay.replay(clip.clip.value!, sampleRate)"
      />
      <Button v-else icon="i-solar:stop-bold" label="Stop the replay" @click="replay.stop()" />
      <span v-if="clip.clip.value" :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        {{ (clip.clip.value.length / sampleRate).toFixed(1) }} s
      </span>
      <span v-if="replay.error.value" :class="['text-sm text-red-500']">{{ replay.error.value }}</span>
    </div>

    <div v-if="voice.drafts.length" :class="['flex flex-col gap-2']">
      <div :class="['text-sm font-medium']">
        Drafts
      </div>
      <div
        v-for="draft in voice.drafts"
        :key="draft.id"
        :class="['flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-2 text-sm dark:border-neutral-700']"
      >
        <span :class="['flex-1']">{{ draft.text || '(empty)' }}</span>
        <Button size="sm" variant="primary" label="Send" :disabled="!draft.text" @click="voice.sendDraft(draft.id)" />
        <Button size="sm" label="Discard" @click="voice.discardDraft(draft.id)" />
      </div>
    </div>

    <div :class="['flex flex-col gap-2']">
      <div :class="['flex items-center gap-3']">
        <div :class="['text-sm font-medium']">
          Turns
        </div>
        <Button size="sm" label="Clear" :disabled="!turns.length" @click="tracer.clear()" />
      </div>
      <table v-if="spokenTurns.length" :class="['w-full text-left text-sm']">
        <thead :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          <tr>
            <th :class="['py-1 pr-3 font-normal']">
              Time
            </th>
            <th :class="['py-1 pr-3 font-normal']">
              Transcript
            </th>
            <th :class="['py-1 pr-3 font-normal']">
              Outcome
            </th>
            <th :class="['py-1 pr-3 font-normal']" title="From the end of speech to the final transcript">
              Transcript after
            </th>
            <th :class="['py-1 pr-3 font-normal']" title="From the end of speech to the first token of the reply">
              First token after
            </th>
            <th :class="['py-1 font-normal']" title="From the end of speech to the first reply audio">
              First audio after
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="{ turn, timing, latency } in spokenTurns"
            :key="turn.id"
            :class="['cursor-pointer border-t border-neutral-200 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800']"
            @click="selectTurn(turn.id)"
          >
            <td :class="['py-1 pr-3 font-mono']">
              {{ formatTime(turn.startTs) }}
            </td>
            <td :class="['py-1 pr-3']">
              {{ turn.inputText || '—' }}
            </td>
            <td :class="['py-1 pr-3']">
              {{ timing.outcome ?? 'running' }}
            </td>
            <td :class="['py-1 pr-3 font-mono']">
              {{ formatMs(latency.transcriptMs) }}
            </td>
            <td :class="['py-1 pr-3 font-mono']">
              {{ formatMs(latency.firstTokenMs) }}
            </td>
            <td :class="['py-1 font-mono']">
              {{ formatMs(latency.firstAudioMs) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        No spoken turn yet. Start the voice host, then speak or replay a clip.
      </p>
      <div :class="['flex h-96 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700']">
        <IOTracerChart
          :turns="turns"
          :selected-span-id="selectedSpanId"
          :time-origin="recordingStartTs"
          :hidden-subsystems="hiddenSubsystems"
          @select-span="tracer.selectSpan($event)"
        />
      </div>
    </div>
  </section>
</template>
