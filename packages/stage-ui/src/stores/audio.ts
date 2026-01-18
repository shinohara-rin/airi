import { useDevicesList, useUserMedia } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'

function getAudioData(analyser: AnalyserNode): number[] {
  const dataBuffer = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(dataBuffer)
  // Convert to array to avoid integer wrapping/clamping with Uint8Array when applying power functions
  return Array.from(dataBuffer)
}

function calculateVolume(analyser: AnalyserNode, mode: 'linear' | 'minmax' = 'linear') {
  const data = getAudioData(analyser)

  if (mode === 'linear') {
    const volumeSum = data
      // The volume changes flatten-ly, while the volume is often low, therefore we need to amplify it.
      // Applying a power function to amplify the volume is helpful, for example:
      // v ** 1.2 will amplify the volume by 1.2 times
      // Scale up the volume values to make them more distinguishable
      .reduce((acc, v) => acc + (v ** 1.2) * 1.2, 0)

    return (volumeSum / data.length / 100)
  }

  if (mode === 'minmax') {
    const amplified = data.map(v => v ** 1.5)

    // Normalize the amplified values using Min-Max scaling
    const min = Math.min(...amplified)
    const max = Math.max(...amplified)
    const range = max - min

    if (range === 0) {
      return 0
    }

    // Aggregate the volume values
    const volumeSum = amplified.reduce((acc, v) => acc + (v - min) / range, 0)

    // Average the volume values
    return volumeSum / data.length
  }

  return 0
}

export const useAudioContext = defineStore('audio-context', () => {
  const audioContext = shallowRef<AudioContext>(new AudioContext())

  return {
    audioContext,
    calculateVolume,
  }
})

export function useAudioDevice(requestPermission: boolean = false) {
  const devices = useDevicesList({ constraints: { audio: true }, requestPermissions: requestPermission })
  const audioInputs = computed(() => devices.audioInputs.value)
  const selectedAudioInput = ref<string>(devices.audioInputs.value.find(device => device.deviceId === 'default')?.deviceId || '')
  const deviceConstraints = computed<MediaStreamConstraints>(() => ({ audio: { deviceId: { exact: selectedAudioInput.value }, autoGainControl: true, echoCancellation: true, noiseSuppression: true } }))
  const { stream, stop: stopStream, start: startStream } = useUserMedia({ constraints: deviceConstraints, enabled: false, autoSwitch: true })

  watch(audioInputs, () => {
    if (!selectedAudioInput.value && audioInputs.value.length > 0) {
      selectedAudioInput.value = audioInputs.value.find(input => input.deviceId === 'default')?.deviceId || audioInputs.value[0].deviceId
    }
  })

  function askPermission() {
    return devices.ensurePermissions()
      .then(() => nextTick())
      .then(() => {
        if (audioInputs.value.length > 0 && !selectedAudioInput.value) {
          selectedAudioInput.value = audioInputs.value.find(input => input.deviceId === 'default')?.deviceId || audioInputs.value[0].deviceId
        }
      })
      .catch((error) => {
        console.error('Error ensuring permissions:', error)
        throw error // Re-throw so callers can handle the error
      })
  }

  return {
    audioInputs,
    selectedAudioInput,
    stream,
    deviceConstraints,

    askPermission,
    startStream,
    stopStream,
  }
}

export const useSpeakingStore = defineStore('character-speaking', () => {
  const nowSpeakingAvatarBorderOpacityMin = 30
  const nowSpeakingAvatarBorderOpacityMax = 100
  const mouthOpenSize = ref(0)
  const nowSpeaking = ref(false)

  const nowSpeakingAvatarBorderOpacity = computed<number>(() => {
    if (!nowSpeaking.value)
      return nowSpeakingAvatarBorderOpacityMin

    return ((nowSpeakingAvatarBorderOpacityMin
      + (nowSpeakingAvatarBorderOpacityMax - nowSpeakingAvatarBorderOpacityMin) * mouthOpenSize.value) / 100)
  })

  return {
    mouthOpenSize,
    nowSpeaking,
    nowSpeakingAvatarBorderOpacity,
  }
})
