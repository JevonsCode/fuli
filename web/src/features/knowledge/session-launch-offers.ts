import { computed, ref, shallowRef, watch, type Ref } from 'vue'

import { getJson } from '@/api/client'
import type { SessionLaunchOffer, SessionLaunchOffers } from '@/types'

// The server's bound on one request (src/http/session-launch-api-router.js).
const MAX_SESSIONS = 20

// The session launcher's answer for each session key (sessionLaunchKey,
// `<sourceApplication>:<sessionId>`; null entries are skipped). Until it
// arrives, and whenever the launcher is unavailable or the request fails, the
// map is empty and every link follows the configured template as before.
// pending: the request for the current keys is still out.
export function useSessionLaunchOffers(sessionKeys: Ref<(string | null)[]>) {
  const offers = shallowRef(new Map<string, SessionLaunchOffer>())
  const pending = ref(false)
  const keys = computed(() => [...new Set(sessionKeys.value.filter((key): key is string => key !== null))]
    .slice(0, MAX_SESSIONS))
  let version = 0
  watch(() => keys.value.join('\n'), async () => {
    const current = ++version
    offers.value = new Map()
    pending.value = keys.value.length > 0
    if (!keys.value.length) return
    const query = new URLSearchParams(keys.value.map((key) => ['session', key]))
    try {
      const answer = await getJson<SessionLaunchOffers>(`/api/session-launch/offers?${query}`)
      if (current !== version || answer?.launcher !== 'available') return
      offers.value = new Map(answer.offers.map((offer) => [`${offer.sourceApplication}:${offer.sessionId}`, offer]))
    } catch {
      // The configured templates keep deciding.
    } finally {
      if (current === version) pending.value = false
    }
  }, { immediate: true })
  return { offers, pending }
}
