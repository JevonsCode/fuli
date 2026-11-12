import { z } from 'zod'
import { ApiError } from '@/api/client'
import { shapeFor } from '@/api/response-shape'

// The LAN roundtable's console payloads (GET /api/peer and the controls that answer with it).

export type ClientId = 'codex' | 'claude_code'

export type Shareable = {
  projectId: string
  projectName: string
  lead: { agentId: string; name: string } | null
  clients: ClientId[]
  // Paired computers that registered this project with the same own repository (rec issue 127).
  sameProjectOn?: { nodeId: string; name: string }[]
  knownFolder?: string | null
}

export type Share = {
  projectId: string
  projectName: string
  agentId: string
  clients: ClientId[]
  workingDirectory?: string | null
  state: 'shared' | 'lead_changed' | 'lead_unavailable' | 'team_unreadable'
}

export type Device = {
  nodeId: string
  name: string
  shortFingerprint: string
  self?: boolean
  status: string
  online?: boolean
}

export type NearbyDevice = { name: string; fingerprint: string; shortFingerprint: string; paired: boolean }

export type NearbyPairing = {
  requestId: string | null
  direction: 'incoming' | 'outgoing'
  state: 'connecting' | 'confirm' | 'finishing' | 'paired' | 'cancelled' | 'expired' | 'failed'
  reason: string | null
  device: { name: string; shortFingerprint: string | null }
  code: string | null
  coordinator: 'this' | 'other'
  confirmedHere: boolean
  confirmedThere: boolean
  expiresAt: string
}

export type Nearby = {
  on: boolean
  name: string | null
  suggestedName: string
  canPair: boolean
  reason: string | null
  devices: NearbyDevice[]
  pairing: NearbyPairing | null
}

export type PeerStatus = {
  beta: boolean
  remoteRemovalPending?: boolean
  role: 'coordinator' | 'member' | null
  device: { fingerprint: string; shortFingerprint: string } | null
  coordinator: { name: string; url: string; shortFingerprint: string; listening: boolean } | null
  addresses: string[]
  devices: Device[]
  openInvitations: number
  shares: Share[]
  shareable: Shareable[]
  lastPublish?: { at: string; agents: number | null; error: string | null; message?: string } | null
  nearby?: Nearby
}

const nearbyShape = z.looseObject({
  on: z.boolean(),
  canPair: z.boolean(),
  devices: z.array(z.looseObject({ name: z.string(), fingerprint: z.string(), shortFingerprint: z.string(), paired: z.boolean() })),
  pairing: z.looseObject({ requestId: z.string().nullable(), state: z.string(), code: z.string().nullable(),
    device: z.looseObject({ name: z.string() }) }).nullable(),
})

// The fields the card relies on in every answer of the peer controls.
export const peerStatusShape = shapeFor<PeerStatus>(z.looseObject({
  role: z.enum(['coordinator', 'member']).nullable(),
  addresses: z.array(z.string()),
  devices: z.array(z.looseObject({ nodeId: z.string(), name: z.string() })),
  shares: z.array(z.looseObject({ projectId: z.string(), state: z.string() })),
  shareable: z.array(z.looseObject({ projectId: z.string(), projectName: z.string() })),
  nearby: nearbyShape.optional(),
}))

// The console's own message for a refused peer control, else the fallback.
export function peerApiMessage(caught: unknown, fallback: string) {
  if (caught instanceof ApiError && caught.detail) {
    try {
      const body = JSON.parse(caught.detail) as { message?: string }
      if (typeof body.message === 'string' && body.message.trim()) return body.message
    } catch { /* use fallback */ }
  }
  return fallback
}

// How an ended pairing reads: the i18n key under settings.peer.pairEnded.
export function pairingOutcome(pairing: NearbyPairing): 'paired' | 'expired' | 'mismatch' | 'cancelled' | 'failed' | null {
  if (pairing.state === 'paired') return 'paired'
  if (pairing.state === 'expired') return 'expired'
  if (pairing.reason === 'code_mismatch') return 'mismatch'
  if (pairing.state === 'cancelled') return 'cancelled'
  if (pairing.state === 'failed') return 'failed'
  return null
}

// A 6-digit code read in two groups of three.
export function groupedCode(code: string) {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}
