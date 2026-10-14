import type { Ref } from 'vue'

import { nanoid } from 'nanoid/non-secure'
import { onScopeDispose, readonly, ref } from 'vue'

import { getSpeechBusContext, voiceListeningLease } from '../services/speech/bus'

/**
 * A lease lasts this long without renewal. Browsers can delay the timers of a hidden page to once a minute,
 * so the lease outlasts that delay. A closed window releases its lease, and a crashed one stops renewing it.
 */
const LEASE_MS = 90_000
const RENEW_MS = 5_000

/** One ID for each window, so that the hosts of a window ignore the lease of that window. */
const windowId = nanoid()

/**
 * Tells if another window holds a listening lease now. A window that opens later learns the lease at its next renewal.
 * Scope disposal stops the observation.
 */
export function useListeningLeasedElsewhere(): Readonly<Ref<boolean>> {
  const leases = new Map<string, number>()
  const leased = ref(false)
  let expiry: ReturnType<typeof setTimeout> | undefined

  function update() {
    clearTimeout(expiry)
    const now = Date.now()
    for (const [holder, until] of leases) {
      if (until <= now)
        leases.delete(holder)
    }
    leased.value = leases.size > 0
    if (leases.size)
      expiry = setTimeout(update, Math.min(...leases.values()) - now)
  }

  const stop = getSpeechBusContext().on(voiceListeningLease, ({ body }) => {
    if (!body || body.holder === windowId)
      return
    leases.set(body.holder, body.until)
    update()
  })
  onScopeDispose(() => {
    stop()
    clearTimeout(expiry)
  })

  return readonly(leased)
}

/**
 * Asks the voice hosts of other windows to stop listening, and renews the request until the returned function releases it.
 * Closing the window also releases it.
 */
export function claimListeningLease(): () => void {
  const bus = getSpeechBusContext()
  const renew = () => void bus.emit(voiceListeningLease, { holder: windowId, until: Date.now() + LEASE_MS })
  const timer = setInterval(renew, RENEW_MS)
  let released = false
  function release() {
    if (released)
      return
    released = true
    clearInterval(timer)
    window.removeEventListener('pagehide', release)
    void bus.emit(voiceListeningLease, { holder: windowId, until: 0 })
  }
  window.addEventListener('pagehide', release)
  renew()
  return release
}
