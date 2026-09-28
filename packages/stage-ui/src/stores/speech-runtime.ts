import { defineStore } from 'pinia'

import { createSpeechPipelineRuntime } from '../services/speech/pipeline-runtime'
import { useModsServerChannelStore } from './mods/api/channel-server'

export const useSpeechRuntimeStore = defineStore('speech-runtime', () => {
  const runtime = createSpeechPipelineRuntime()
  const serverChannel = useModsServerChannelStore()
  let stopSpeech: (() => void) | undefined
  let stopReconnect: (() => void) | undefined
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
    const registerConsumer = () => serverChannel.send({ type: 'module:consumer:register', data: consumer })
    registerConsumer()
    stopReconnect = serverChannel.onReconnected(registerConsumer)
  }

  function isHost() {
    return runtime.isHost()
  }

  async function dispose() {
    if (stopSpeech) {
      stopSpeech()
      stopReconnect?.()
      stopSpeech = undefined
      stopReconnect = undefined
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
