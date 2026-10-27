import { reactive } from 'vue'
import { getJson, postJson, putJson } from '@/api/client'
import type { ClientLinksCheck, ClientLinksState } from './model'

// The manifest is read once per page load and shared: every blocked task
// builds its links from it, and the settings section updates it.
const shared = reactive({
  state: null as ClientLinksState | null,
  lastCheck: null as ClientLinksCheck | null,
})
let reading: Promise<void> | null = null
let pending = false

// force re-reads a finished read; a read still under way is always shared.
function load({ force = false } = {}) {
  if (reading && (!force || pending)) return reading
  pending = true
  reading = getJson<ClientLinksState>('/api/client-links')
    .then(value => { shared.state = value })
    .catch(error => { reading = null; throw error })
    .finally(() => { pending = false })
  return reading
}

async function check() {
  shared.lastCheck = await postJson<ClientLinksCheck>('/api/client-links/check', {})
  if (shared.state) shared.state.lastCheckedAt = shared.lastCheck.checkedAt
  return shared.lastCheck
}

async function apply(digest: string) {
  shared.state = await postJson<ClientLinksState>('/api/client-links/apply', { digest })
  shared.lastCheck = null
}

async function setAutoUpdate(enabled: boolean) {
  shared.state = await putJson<ClientLinksState>('/api/client-links/auto-update', { enabled })
}

const store = Object.assign(shared, { load, check, apply, setAutoUpdate })

export function useClientLinks() {
  return store
}
