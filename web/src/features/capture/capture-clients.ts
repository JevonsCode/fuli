import { z } from 'zod'

import { shapeOf } from '@/api/response-shape'
import type { CapturePolicy } from '@/types'

import { captureSourceOff } from './capture-sources'

// The clients FULI captures from (src/agents/<client>), by capture source id.
// Also the list shown when this machine's clients cannot be read.
export const CAPTURE_CLIENTS = [['claude_code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['opencode', 'OpenCode']] as const
export type CaptureClient = typeof CAPTURE_CLIENTS[number]

// Only what the capture switches read of /api/system/client-connection/status.
const clientDetectionSchema = z.looseObject({
  available: z.boolean().optional(),
  clients: z.array(z.looseObject({ id: z.string(), status: z.string() })),
})
export const clientDetectionShape = shapeOf(clientDetectionSchema)
export type ClientDetection = z.infer<typeof clientDetectionSchema>

// agent-installer names a client `claude-code`; capture names it `claude_code`.
export function captureSourceFor(clientId: string): string | null {
  const source = clientId.replaceAll('-', '_')
  return CAPTURE_CLIENTS.some(([known]) => known === source) ? source : null
}

// A switch for each capturable client on this machine, plus any turned off so it can be turned back on.
export function shownCaptureClients(detection: ClientDetection | null,
  policy: Pick<CapturePolicy, 'disabledSources' | 'capturedSources'>): readonly CaptureClient[] {
  if (!detection || detection.available === false) return CAPTURE_CLIENTS
  const detected = new Set(detection.clients.filter(client => client.status !== 'not_detected').map(client => captureSourceFor(client.id)))
  return CAPTURE_CLIENTS.filter(([source]) => detected.has(source) || captureSourceOff(policy, source))
}
