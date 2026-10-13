import { describe, expect, it } from 'vitest'

import { defaultNucleusOptions } from './articulation'
import { AudioHistory, selectSpeech } from './live'

const sampleRate = 16000
const options = { nucleus: defaultNucleusOptions, minNuclei: 2, marginSeconds: 0.3 }

/** Silence, then syllables of 0.15 s every 0.25 s, at `amplitude`. */
function speechAfter(silenceSeconds: number, syllables: number, amplitude: number) {
  const length = Math.round((silenceSeconds + 0.25 * syllables + 0.2) * sampleRate)
  return Float32Array.from({ length }, (_, index) => {
    const time = index / sampleRate - silenceSeconds
    const local = time % 0.25
    const envelope = time >= 0 && time < 0.25 * syllables && local < 0.15 ? amplitude * Math.sin(Math.PI * local / 0.15) : 0
    // A little noise keeps silence from becoming -120 dB, as on a real microphone.
    return envelope * Math.sin(2 * Math.PI * 180 * index / sampleRate) + 0.0005 * Math.sin(index * 12.9898)
  })
}

describe('audioHistory', () => {
  it('copies across chunk borders and leaves out dropped audio', () => {
    const history = new AudioHistory(10)
    history.append(Float32Array.from([0, 1, 2, 3, 4]))
    history.append(Float32Array.from([5, 6, 7, 8, 9]))

    expect(history.slice(0.3, 0.7)).toEqual(Float32Array.from([3, 4, 5, 6]))
    history.dropBefore(0.6)
    expect(history.slice(0.3, 0.7)).toEqual(Float32Array.from([5, 6]))
  })
})

describe('selectSpeech', () => {
  it('cuts the pause before the speech of a segment with tokens', () => {
    const selection = selectSpeech(speechAfter(2, 3, 0.5), sampleRate, true, undefined, options)

    expect(selection?.offset).toBeGreaterThan(1.5)
    expect(selection?.offset).toBeLessThan(2)
  })

  it('skips a silent segment without tokens', () => {
    const speechDb = selectSpeech(speechAfter(0.2, 3, 0.5), sampleRate, true, undefined, options)!.loudDb

    expect(selectSpeech(speechAfter(2, 0, 0), sampleRate, false, speechDb, options)).toBeUndefined()
  })

  it('keeps a segment without tokens when it has syllables as loud as earlier speech', () => {
    const speechDb = selectSpeech(speechAfter(0.2, 3, 0.5), sampleRate, true, undefined, options)!.loudDb

    expect(selectSpeech(speechAfter(1, 3, 0.3), sampleRate, false, speechDb, options)?.offset).toBeGreaterThan(0.5)
    // Without earlier speech there is no level to compare with.
    expect(selectSpeech(speechAfter(1, 3, 0.3), sampleRate, false, undefined, options)).toBeUndefined()
  })
})
