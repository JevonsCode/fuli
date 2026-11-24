import { shallowRef } from 'vue'
import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
import { defaultAvatarUrl, generatedAvatarUrl } from './agent-avatar'

// Faces of Agents on paired computers (LAN roundtable). Here they are named by
// their peer address (`peer:<device>:<binding>`), but their face is the one their
// own computer shows: drawn from their agentId there, or from the seed their
// person re-rolled (the directory's `look`). A picture uploaded there is not
// sent yet, so such an Agent shows its default drawing here. These faces live in
// their own map by address and never touch this computer's own looks.
export type RemoteFace = { agentId: string; name: string | null; device: string | null; seed: string | null }

const remoteAgentSchema = z.looseObject({
  address: z.string(),
  agentId: z.string(),
  name: z.string().nullish(),
  device: z.looseObject({ name: z.string().nullish() }).nullish(),
  look: z.looseObject({ kind: z.string(), seed: z.string().nullish() }).nullish(),
})
type RemoteAgent = z.infer<typeof remoteAgentSchema>
// GET /api/roundtable/agents (find_agents); a computer outside a LAN roundtable has no remoteAgents,
// and an unreachable coordinator answers an empty list with remoteUnavailable.
type AgentsAnswer = { remoteAgents?: RemoteAgent[] | null; remoteUnavailable?: string | null }
const agentsShape = shapeFor<AgentsAnswer>(z.looseObject({
  remoteAgents: z.array(remoteAgentSchema).nullish(), remoteUnavailable: z.string().nullish(),
}))

const ADDRESS = /^peer:([0-9a-f]{16}):(.+)$/

export const remoteFaces = shallowRef<ReadonlyMap<string, RemoteFace>>(new Map())
let reading: Promise<void> | null = null

export const isRemoteAgentId = (id: string) => id.startsWith('peer:')

/** The face an Agent on another computer has there. */
export function remoteAvatarUrl(address: string): string {
  const face = remoteFaces.value.get(address)
  if (face?.seed) return generatedAvatarUrl(face.seed)
  // Not in the directory (yet): a sender another computer names `peer:<device>:<its agentId>`
  // ends in its own agentId, so its default face still matches.
  return defaultAvatarUrl(face?.agentId ?? ADDRESS.exec(address)?.[2] ?? address)
}

/** What a face in a chat room is drawn from: the peer address when it lives on another computer, else its own agentId. */
export const memberFaceId = (member: { address: string; agentId: string | null }) =>
  remoteFaces.value.has(member.address) ? member.address : member.agentId

function faces(agents: RemoteAgent[]) {
  const map = new Map<string, RemoteFace>()
  for (const agent of agents) {
    const device = ADDRESS.exec(agent.address)?.[1]
    if (!device) continue
    const face = { agentId: agent.agentId, name: agent.name ?? null, device: agent.device?.name ?? null,
      seed: agent.look?.kind === 'generated' ? agent.look.seed ?? null : null }
    // Asked from here it is its binding's address; asking here, it signs with its agentId.
    map.set(agent.address, face)
    map.set(`peer:${device}:${agent.agentId}`, face)
  }
  return map
}

/** The key a frame's identity colour uses: a known remote Agent's own agentId, as its home computer keys it; any other id unchanged. */
export const identityKeyOf = (id: string | null | undefined) => (id && remoteFaces.value.get(id)?.agentId) || id

let latest: Promise<void> | null = null

/** Reads the paired computers' shared Agents; a call while one read runs shares it. A failed read keeps the faces known so far. */
export function loadRemoteFaces(): Promise<void> {
  reading ??= getJson('/api/roundtable/agents', agentsShape)
    .then(({ remoteAgents, remoteUnavailable }) => { if (remoteAgents && !remoteUnavailable) remoteFaces.value = faces(remoteAgents) })
    .catch(() => {})
    .finally(() => { reading = null })
  latest = reading
  return reading
}

/**
 * Settles once the latest read did (starting one if none ran). A chat room on
 * paired computers names every member, this computer's own included, by a peer
 * address; only the map tells which live elsewhere, so a room waits for it and
 * its faces never change from local to remote under the reader's eyes.
 */
export const remoteFacesReady = () => latest ?? loadRemoteFaces()
