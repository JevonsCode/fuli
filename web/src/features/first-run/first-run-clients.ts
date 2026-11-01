import { z } from 'zod'

import { shapeFor } from '@/api/response-shape'
import { canConnect, type ClientObservation, type ConnectionResult, type ConnectionStatus } from '@/features/settings/client-connection-model'

// What the guide reads of /api/system/client-connection/status and of each connect answer.
export const connectionStatusShape = shapeFor<ConnectionStatus>(z.looseObject({
  available: z.boolean().optional(),
  clients: z.array(z.looseObject({ id: z.string(), label: z.string(), status: z.string(), detected: z.boolean() })),
}))
export const connectionResultShape = shapeFor<ConnectionResult>(z.looseObject({ id: z.string(), status: z.string() }))

// The clients installed on this computer; the ones not found are left to 设置 › 客户端.
export function detectedClients(status: ConnectionStatus | null): ClientObservation[] {
  return (status?.clients ?? []).filter(client => client.detected && client.status !== 'not_detected')
}

// What 「一键接入」 starts with: every detected client FULI can connect that is not connected yet.
export function preselectedClients(clients: readonly ClientObservation[]): Record<string, boolean> {
  return Object.fromEntries(clients.filter(client => canConnect(client) && client.status !== 'connected').map(client => [client.id, true]))
}

// One connect answer as the row shows it: connected (maybe after a restart), or not done.
export function connectOutcome(result: ConnectionResult | null): 'connected' | 'restart' | 'failed' {
  if (result?.status !== 'connected') return 'failed'
  return result.restartRequired ? 'restart' : 'connected'
}
