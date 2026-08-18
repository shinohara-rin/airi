<script setup lang="ts">
import type { Live2DIdleMotionTuning } from '@proj-airi/stage-ui-live2d'

import { FieldRange } from '@proj-airi/ui'
import { useI18n } from 'vue-i18n'

const tuning = defineModel<Live2DIdleMotionTuning>({ required: true })
const frequency = defineModel<number>('frequency', { required: true })

const { t } = useI18n()
</script>

<template>
  <FieldRange
    v-model="frequency"
    as="div"
    :min="0.25"
    :max="3"
    :step="0.25"
    :label="t('settings.live2d.animation.idle-motion-frequency.title')"
    :description="t('settings.live2d.animation.idle-motion-frequency.description')"
  />
  <div grid grid-cols-1 gap-4 md:grid-cols-2>
    <FieldRange
      v-model="tuning.speedRate"
      as="div"
      :min="0.01"
      :max="1"
      :step="0.01"
      :label="t('settings.live2d.animation.idle-motion-tuning.speed-rate')"
    />
    <FieldRange
      v-model="tuning.speedVariation"
      as="div"
      :min="0"
      :max="1"
      :step="0.01"
      :label="t('settings.live2d.animation.idle-motion-tuning.speed-variation')"
    />
    <FieldRange
      v-model="tuning.springStiffness"
      as="div"
      :min="1"
      :max="80"
      :step="1"
      :label="t('settings.live2d.animation.idle-motion-tuning.spring-stiffness')"
    />
    <FieldRange
      v-model="tuning.springDamping"
      as="div"
      :min="0"
      :max="30"
      :step="0.5"
      :label="t('settings.live2d.animation.idle-motion-tuning.spring-damping')"
    />
  </div>
  <div mt-4 text-sm font-medium>
    {{ t('settings.live2d.animation.idle-motion-tuning.x-title') }}
  </div>
  <div grid grid-cols-1 gap-4 md:grid-cols-2>
    <FieldRange v-model="tuning.x.primaryRate" as="div" :min="0.01" :max="4" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.primary-rate')" />
    <FieldRange v-model="tuning.x.detailRate" as="div" :min="0.01" :max="4" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.detail-rate')" />
    <FieldRange v-model="tuning.x.chaosRate" as="div" :min="0.01" :max="4" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.chaos-rate')" />
    <FieldRange v-model="tuning.x.primaryAmplitude" as="div" :min="0" :max="1" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.primary-amplitude')" />
    <FieldRange v-model="tuning.x.detailAmplitude" as="div" :min="0" :max="1" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.detail-amplitude')" />
    <FieldRange v-model="tuning.x.chaosAmplitude" as="div" :min="0" :max="1" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.chaos-amplitude')" />
  </div>
  <div mt-4 text-sm font-medium>
    {{ t('settings.live2d.animation.idle-motion-tuning.y-title') }}
  </div>
  <div grid grid-cols-1 gap-4 md:grid-cols-2>
    <FieldRange v-model="tuning.y.primaryRate" as="div" :min="0.01" :max="4" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.primary-rate')" />
    <FieldRange v-model="tuning.y.detailRate" as="div" :min="0.01" :max="4" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.detail-rate')" />
    <FieldRange v-model="tuning.y.chaosRate" as="div" :min="0.01" :max="4" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.chaos-rate')" />
    <FieldRange v-model="tuning.y.primaryAmplitude" as="div" :min="0" :max="1" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.primary-amplitude')" />
    <FieldRange v-model="tuning.y.detailAmplitude" as="div" :min="0" :max="1" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.detail-amplitude')" />
    <FieldRange v-model="tuning.y.chaosAmplitude" as="div" :min="0" :max="1" :step="0.01" :label="t('settings.live2d.animation.idle-motion-tuning.chaos-amplitude')" />
  </div>
</template>
