<script setup lang="ts">
import { AgentLoop } from '@proj-airi/stage-ui/components'
</script>

<template>
  <AgentLoop />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.autonomy.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
