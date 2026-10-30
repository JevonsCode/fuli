import { computed, shallowRef, watch, type Ref } from 'vue'

import { getJson } from '@/api/client'
import type { EvidenceRecord, SessionLaunchOffer, SessionLaunchOffers } from '@/types'
import { sessionLaunchKey } from './source-adapters'

// The server's bound on one request (src/http/session-launch-api-router.js).
const MAX_SESSIONS = 20

// The session launcher's answer for each evidence session, keyed by
// sessionLaunchKey. Until it arrives, and whenever the launcher is
// unavailable or the request fails, the map is empty and every link follows
// the configured template as before.
export function useSessionLaunchOffers(evidence: Ref<EvidenceRecord[]>) {
  const offers = shallowRef(new Map<string, SessionLaunchOffer>())
  const keys = computed(() => [...new Set(evidence.value.map(sessionLaunchKey).filter((key): key is string => key !== null))]
    .slice(0, MAX_SESSIONS))
  let version = 0
  watch(() => keys.value.join('\n'), async () => {
    const current = ++version
    offers.value = new Map()
    if (!keys.value.length) return
    const query = new URLSearchParams(keys.value.map((key) => ['session', key]))
    try {
      const answer = await getJson<SessionLaunchOffers>(`/api/session-launch/offers?${query}`)
      if (current !== version || answer?.launcher !== 'available') return
      offers.value = new Map(answer.offers.map((offer) => [`${offer.sourceApplication}:${offer.sessionId}`, offer]))
    } catch {
      // The configured templates keep deciding.
    }
  }, { immediate: true })
  return offers
}
