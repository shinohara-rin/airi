<script setup lang="ts">
import { Callout, FieldCheckbox, FieldInput, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useWholeNumber } from '../../composables/use-whole-number'
import { useAgentLoopSettingsStore } from '../../stores/agent-loop-settings'

/** The interval a heartbeat starts with when the user turns it on. */
const DEFAULT_HEARTBEAT_SECONDS = 30
const MIN_HEARTBEAT_SECONDS = 5
const DEFAULT_SPEND_GUARD_TOKENS = 2_000_000
const MIN_SPEND_GUARD_TOKENS = 1000
const MIN_SPEND_GUARD_WINDOW_SECONDS = 10

const { t } = useI18n()
const settings = useAgentLoopSettingsStore()
const { heartbeatSeconds, speechEndTrigger, spendGuardTokens, spendGuardWindowSeconds } = storeToRefs(settings)

const heartbeatEnabled = computed({
  get: () => heartbeatSeconds.value > 0,
  set: (enabled: boolean) => {
    heartbeatSeconds.value = enabled ? DEFAULT_HEARTBEAT_SECONDS : 0
  },
})

const spendGuardEnabled = computed({
  get: () => spendGuardTokens.value > 0,
  set: (enabled: boolean) => {
    spendGuardTokens.value = enabled ? DEFAULT_SPEND_GUARD_TOKENS : 0
  },
})

const heartbeatSecondsText = useWholeNumber(heartbeatSeconds, MIN_HEARTBEAT_SECONDS)
const spendGuardTokensText = useWholeNumber(spendGuardTokens, MIN_SPEND_GUARD_TOKENS)
const spendGuardWindowSecondsText = useWholeNumber(spendGuardWindowSeconds, MIN_SPEND_GUARD_WINDOW_SECONDS)

const speechEndOptions = computed(() => [
  {
    label: t('settings.pages.modules.autonomy.speech-end.options.piggyback.label'),
    description: t('settings.pages.modules.autonomy.speech-end.options.piggyback.description'),
    value: 'piggyback' as const,
  },
  {
    label: t('settings.pages.modules.autonomy.speech-end.options.debounce.label'),
    description: t('settings.pages.modules.autonomy.speech-end.options.debounce.description'),
    value: 'debounce' as const,
  },
  {
    label: t('settings.pages.modules.autonomy.speech-end.options.flush.label'),
    description: t('settings.pages.modules.autonomy.speech-end.options.flush.description'),
    value: 'flush' as const,
  },
])
</script>

<template>
  <div
    :class="[
      'h-fit w-full',
      'flex flex-col gap-4',
      'rounded-xl bg-neutral-100 p-4 dark:bg-[rgba(0,0,0,0.3)]',
    ]"
  >
    <FieldCheckbox
      v-model="heartbeatEnabled"
      :label="t('settings.pages.modules.autonomy.heartbeat.enable')"
      :description="t('settings.pages.modules.autonomy.heartbeat.enable-description')"
    />

    <FieldInput
      v-if="heartbeatEnabled"
      v-model="heartbeatSecondsText"
      type="number"
      :min="MIN_HEARTBEAT_SECONDS"
      :step="5"
      :label="t('settings.pages.modules.autonomy.heartbeat.interval')"
      :description="t('settings.pages.modules.autonomy.heartbeat.interval-description')"
    />

    <FieldSelect
      v-model="speechEndTrigger"
      :label="t('settings.pages.modules.autonomy.speech-end.label')"
      :description="t('settings.pages.modules.autonomy.speech-end.description')"
      :options="speechEndOptions"
    />

    <FieldCheckbox
      v-model="spendGuardEnabled"
      :label="t('settings.pages.modules.autonomy.spend-guard.enable')"
      :description="t('settings.pages.modules.autonomy.spend-guard.enable-description')"
    />

    <template v-if="spendGuardEnabled">
      <FieldInput
        v-model="spendGuardTokensText"
        type="number"
        :min="MIN_SPEND_GUARD_TOKENS"
        :step="100000"
        :label="t('settings.pages.modules.autonomy.spend-guard.tokens')"
        :description="t('settings.pages.modules.autonomy.spend-guard.tokens-description')"
      />

      <FieldInput
        v-model="spendGuardWindowSecondsText"
        type="number"
        :min="MIN_SPEND_GUARD_WINDOW_SECONDS"
        :step="60"
        :label="t('settings.pages.modules.autonomy.spend-guard.window')"
        :description="t('settings.pages.modules.autonomy.spend-guard.window-description')"
      />
    </template>

    <Callout
      v-if="heartbeatEnabled"
      theme="orange"
      :label="t('settings.pages.modules.autonomy.cost-notice')"
    />
  </div>
</template>
