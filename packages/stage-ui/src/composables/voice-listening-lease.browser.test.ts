import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'

import { getSpeechBusContext, voiceListeningLease } from '../services/speech/bus'
import { claimListeningLease, useListeningLeasedElsewhere } from './voice-listening-lease'

function observe() {
  const scope = effectScope(true)
  const leased = scope.run(() => useListeningLeasedElsewhere())!
  return { leased, stop: () => scope.stop() }
}

describe('useListeningLeasedElsewhere', () => {
  it('follows the lease of another window until it is released', () => {
    const { leased, stop } = observe()

    getSpeechBusContext().emit(voiceListeningLease, { holder: 'other-window', until: Date.now() + 60_000 })
    expect(leased.value).toBe(true)

    getSpeechBusContext().emit(voiceListeningLease, { holder: 'other-window', until: 0 })
    expect(leased.value).toBe(false)
    stop()
  })

  it('ends a lease that is not renewed', async () => {
    const { leased, stop } = observe()

    getSpeechBusContext().emit(voiceListeningLease, { holder: 'crashed-window', until: Date.now() + 30 })
    expect(leased.value).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(leased.value).toBe(false)
    stop()
  })

  it('ignores the lease of its own window', () => {
    const { leased, stop } = observe()

    const release = claimListeningLease()
    expect(leased.value).toBe(false)
    release()
    stop()
  })
})
