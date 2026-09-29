import { defineStore } from 'pinia'
import { watch } from 'vue'

import { createSpeechPipelineRuntime } from '../services/speech/pipeline-runtime'
import { useModsServerChannelStore } from './mods/api/channel-server'

export const useSpeechRuntimeStore = defineStore('speech-runtime', () => {
  const runtime = createSpeechPipelineRuntime()
  const serverChannel = useModsServerChannelStore()
  let stopSpeech: (() => void) | undefined
  let stopConnectionWatch: (() => void) | undefined
  const consumer = { event: 'output:speech', mode: 'consumer-group', group: 'speech-output' } as const

  function openIntent(options?: Parameters<typeof runtime.openIntent>[0]) {
    return runtime.openIntent(options)
  }

  async function registerHost(pipeline: Parameters<typeof runtime.registerHost>[0]) {
    await runtime.registerHost(pipeline)
    if (stopSpeech)
      return

    stopSpeech = serverChannel.onEvent('output:speech', (event) => {
      const text = event.data?.text
      if (typeof text !== 'string' || !text.trim())
        return

      const intent = runtime.openIntent({ behavior: 'queue', priority: 'normal' })
      intent.writeLiteral(text)
      intent.writeFlush()
      intent.end()
    })
    // A replacement socket can be a first connection after the token loads.
    // Register on each connected transition, including those without a reconnect callback.
    stopConnectionWatch = watch(() => serverChannel.connected, (connected) => {
      if (connected)
        serverChannel.send({ type: 'module:consumer:register', data: consumer })
    }, { immediate: true, flush: 'sync' })
  }

  function isHost() {
    return runtime.isHost()
  }

  async function dispose() {
    if (stopSpeech) {
      stopSpeech()
      stopConnectionWatch?.()
      stopSpeech = undefined
      stopConnectionWatch = undefined
      serverChannel.send({ type: 'module:consumer:unregister', data: consumer })
    }
    await runtime.dispose()
  }

  return {
    openIntent,
    registerHost,
    isHost,
    dispose,
  }
})
