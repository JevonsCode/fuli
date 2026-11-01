import { reactive } from 'vue'
import { z } from 'zod'
import { getJson, postJson, putJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
import type { ClientLinksCheck, ClientLinksState } from './model'

// The manifest and the update check as the server answers them: the fields
// the settings page and the session links read. The server validates a
// manifest whole before it serves one, so only its structure is checked here.
const diffEntries = z.array(z.looseObject({ id: z.string(), name: z.string() }))
const clientLinksDiff = z.looseObject({
  fromVersion: z.number(),
  toVersion: z.number(),
  added: diffEntries,
  changed: diffEntries,
  removed: diffEntries,
})
const clientLinksStateShape = shapeFor<ClientLinksState>(z.looseObject({
  manifest: z.looseObject({
    manifestVersion: z.number(),
    updatedAt: z.string(),
    clients: z.array(z.looseObject({
      id: z.string(),
      name: z.string(),
      sessionLinks: z.array(z.looseObject({
        opens: z.string(),
        template: z.string(),
        parameters: z.record(z.string(), z.looseObject({ format: z.string() })),
        notes: z.string().nullish(),
        source: z.string().nullish(),
      })),
      noSessionLink: z.string().nullish(),
    })),
  }),
  source: z.string(),
  autoUpdate: z.boolean(),
  lastCheckedAt: z.string().nullish(),
  history: z.array(clientLinksDiff.extend({ appliedAt: z.string() })),
}))
const clientLinksCheckShape = shapeFor<ClientLinksCheck>(z.discriminatedUnion('status', [
  z.looseObject({ status: z.literal('update_available'), checkedAt: z.string(), digest: z.string(), updatedAt: z.string(), diff: clientLinksDiff }),
  z.looseObject({ status: z.literal('up_to_date'), checkedAt: z.string(), manifestVersion: z.number() }),
  z.looseObject({ status: z.literal('unavailable'), checkedAt: z.string(), reason: z.string() }),
  z.looseObject({ status: z.literal('invalid'), checkedAt: z.string(), reason: z.string() }),
]))

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
  reading = getJson('/api/client-links', clientLinksStateShape)
    .then(value => { shared.state = value })
    .catch(error => { reading = null; throw error })
    .finally(() => { pending = false })
  return reading
}

async function check() {
  shared.lastCheck = await postJson('/api/client-links/check', {}, clientLinksCheckShape)
  if (shared.state) shared.state.lastCheckedAt = shared.lastCheck.checkedAt
  return shared.lastCheck
}

async function apply(digest: string) {
  shared.state = await postJson('/api/client-links/apply', { digest }, clientLinksStateShape)
  shared.lastCheck = null
}

async function setAutoUpdate(enabled: boolean) {
  shared.state = await putJson('/api/client-links/auto-update', { enabled }, clientLinksStateShape)
}

const store = Object.assign(shared, { load, check, apply, setAutoUpdate })

export function useClientLinks() {
  return store
}
