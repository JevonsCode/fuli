import { shallowRef } from 'vue'
import { getJson, putJson } from '@/api/client'

// The looks the person chose for their Agents (rec#11 D-89), one copy for the
// whole console so the dock, cards and capsules change together. Only changed
// Agents are listed; every other one keeps its default drawing. A console
// without the route (an older local FULI) shows every Agent on its default.
export type AgentLook =
  | { agentId: string; kind: 'generated'; seed: string; updatedAt: string }
  | { agentId: string; kind: 'image'; imageVersion: string; updatedAt: string }
export type LookChoice = { kind: 'generated'; seed: string } | { kind: 'image'; data: string } | { kind: 'default' }
interface LookView { agentId: string; kind: 'generated' | 'image' | 'default'; seed?: string; imageVersion?: string; updatedAt: string }

export const agentLooks = shallowRef<ReadonlyMap<string, AgentLook>>(new Map())
let loadedSpace = ''
let reading: Promise<void> | null = null

const looksPath = (spaceId: string) => `/api/agent-avatars?${new URLSearchParams({ personalSpaceId: spaceId })}`

function asLook(view: LookView): AgentLook | null {
  if (view.kind === 'generated' && view.seed) return { agentId: view.agentId, kind: 'generated', seed: view.seed, updatedAt: view.updatedAt }
  if (view.kind === 'image' && view.imageVersion) return { agentId: view.agentId, kind: 'image', imageVersion: view.imageVersion, updatedAt: view.updatedAt }
  return null
}

async function read(spaceId: string) {
  try {
    const { avatars } = await getJson<{ avatars: LookView[] }>(looksPath(spaceId))
    if (spaceId !== loadedSpace) return
    agentLooks.value = new Map(avatars.flatMap(view => { const look = asLook(view); return look ? [[look.agentId, look] as const] : [] }))
  } catch {
    // A missing or failing route leaves every Agent on its default drawing.
  }
}

/** Reads the space's looks once; a later call for the same space reuses that read. */
export function loadAgentLooks(spaceId: string): Promise<void> {
  if (!spaceId) return Promise.resolve()
  if (spaceId === loadedSpace && reading) return reading
  loadedSpace = spaceId
  agentLooks.value = new Map()
  reading = read(spaceId)
  return reading
}

/** Saves one Agent's look, shows it everywhere at once, then reads the list again. */
export async function saveAgentLook(spaceId: string, agentId: string, look: LookChoice): Promise<void> {
  const view = await putJson<LookView>(`/api/agent-avatars/${encodeURIComponent(agentId)}`, { personalSpaceId: spaceId, look })
  if (spaceId === loadedSpace) {
    const next = new Map(agentLooks.value)
    const saved = asLook(view)
    if (saved) next.set(agentId, saved)
    else next.delete(agentId)
    agentLooks.value = next
  }
  reading = read(spaceId)
  await reading
}

/** Test seam: forget the loaded space and every look. */
export function forgetAgentLooks() {
  loadedSpace = ''
  reading = null
  agentLooks.value = new Map()
}
