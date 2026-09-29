import type { PlaybackItem } from '@proj-airi/pipelines-audio'
import type { WebSocketEvents } from '@proj-airi/server-sdk'

import { createSpeechPipeline } from '@proj-airi/pipelines-audio'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

import { useSpeechRuntimeStore } from './speech-runtime'

const listeners = new Map<string, (event: { data: unknown }) => void>()
const send = vi.fn()
const channelState = reactive({ connected: true })

vi.mock('./mods/api/channel-server', () => ({
  useModsServerChannelStore: () => ({
    send,
    get connected() { return channelState.connected },
    onEvent(type: keyof WebSocketEvents, handler: (event: { data: unknown }) => void) {
      listeners.set(type, handler)
      return () => listeners.delete(type)
    },
  }),
}))

const pinia = createPinia()
setActivePinia(pinia)

afterEach(async () => {
  await useSpeechRuntimeStore(pinia).dispose()
  disposePinia(pinia)
})

it('plays external speech literally without a chat provider and unregisters on disposal', async () => {
  const played: PlaybackItem<AudioBuffer>[] = []
  const ttsTexts: string[] = []
  const pipeline = createSpeechPipeline<AudioBuffer>({
    async tts(request) {
      ttsTexts.push(request.text)
      return new AudioBuffer({ length: 128, sampleRate: 24000 })
    },
    playback: {
      schedule(item) { played.push(item) },
      stopAll() {},
      stopByIntent() {},
      stopByOwner() {},
      onStart() {},
      onEnd() {},
      onInterrupt() {},
      onReject() {},
    },
  })
  const store = useSpeechRuntimeStore()
  await store.registerHost(pipeline)
  await store.registerHost(pipeline)

  listeners.get('output:speech')?.({ data: { text: 'Found 16 logs' } })
  await vi.waitFor(() => expect(played.map(item => item.text)).toEqual(['Found 16 logs']))
  expect(ttsTexts).toEqual(['Found 16 logs'])
  expect(send).toHaveBeenCalledWith({
    type: 'module:consumer:register',
    data: { event: 'output:speech', mode: 'consumer-group', group: 'speech-output' },
  })
  expect(send).toHaveBeenCalledTimes(1)

  listeners.get('output:speech')?.({ data: { text: '   ' } })
  listeners.get('output:speech')?.({ data: { text: 42 } })
  expect(ttsTexts).toEqual(['Found 16 logs'])

  // ROOT CAUSE: Tamagotchi can replace its initial socket when it loads the
  // server token. The replacement has a first connection, so onReconnected
  // does not run and the server has no speech consumer for the new socket.
  channelState.connected = false
  await nextTick()
  channelState.connected = true
  await nextTick()
  expect(send).toHaveBeenCalledTimes(2)
  await store.dispose()
  expect(listeners.has('output:speech')).toBe(false)
  channelState.connected = false
  await nextTick()
  channelState.connected = true
  await nextTick()
  expect(send).toHaveBeenCalledTimes(3)
  expect(send).toHaveBeenLastCalledWith({
    type: 'module:consumer:unregister',
    data: { event: 'output:speech', mode: 'consumer-group', group: 'speech-output' },
  })
})
