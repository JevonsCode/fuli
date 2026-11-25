import moveProblems from '../../../../src/runner/move-problems.json'
import { z } from 'zod'
import { apiErrorCode, apiErrorReason } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

const device = z.object({ fingerprint: z.string(), name: z.string(), revokedAt: z.string().nullable() })
const project = z.object({ project: z.string(), owner: z.string(), generation: z.number(), state: z.string(),
  writableHere: z.boolean(), gate: z.object({ state: z.string(), role: z.string() }).nullable(),
  source: z.object({ status: z.string(), checkedAt: z.string().nullish(), syncedAt: z.string().nullish() }).nullable() })
const move = z.object({ project: z.string(), moveId: z.string(), step: z.string(), source: z.string(),
  target: z.string(), reason: z.string().nullable(), decision: z.string().nullish() })
const directory = z.object({ device: z.string().optional(), ready: z.boolean(), projects: z.array(project),
  preparing: z.boolean().optional(), pendingInventory: z.array(z.object({ fingerprint: z.string(), name: z.string().nullable() })).optional(),
  more: z.boolean().optional(), moves: z.array(move) })
const grant = z.object({ scope: z.string(), state: z.enum(['allowed','pending','revoked']), version: z.number() })
const grants = z.object({ pairing: z.string(), scopes: z.array(grant) })
export type Device = z.infer<typeof device>
export type Directory = z.infer<typeof directory>
export type Move = z.infer<typeof move>
export type Grants = z.infer<typeof grants>
export const directoryShape = shapeOf(directory)
export const inventoryShape = shapeOf(z.object({ pairing: z.string().nullable(), checkedAt: z.string().nullable(),
  revokedAt: z.string().nullable(), retiredAt: z.string().nullable() }))
export const grantsShape = shapeOf(grants)
export const grantShape = shapeOf(grant)
export const moveShape = shapeOf(move)
export const devicesShape = shapeOf(z.object({ runners: z.array(device) }))
export const inviteShape = shapeOf(z.object({ invitation: z.string() }))

const messages: Record<string, string> = {
  move_pairing_changed: 'pairChanged', pairing_changed: 'pairChanged', decision_changed: 'reloadGrant',
  move_peer_ack_abandoned: 'peerClosed', local_user_only: 'localOnly', inventory_already_checked: 'inventoryComplete', scope_invalid: 'invalidScope',
  runner_unknown: 'unknownRunner', scope_controls_unavailable: 'controlsUnavailable', move_abandon_unavailable: 'abandonUnavailable',
  owner_offline: 'offline', owner_result_unknown: 'unconfirmed',
  move_unavailable: 'paused', move_participant_unavailable: 'paused', move_already_committed: 'decided',
  ownership_unverified: 'checkOwner', scope_not_owned: 'checkOwner',
  move_in_progress: 'alreadyMoving', project_move_in_progress: 'alreadyMoving'
}
export function moveProblem(code: string) {
  if (Object.hasOwn(moveProblems.codes, code)) {
    return t('ownership.moveProblems.' + moveProblems.codes[code as keyof typeof moveProblems.codes])
  }
  return t('ownership.' + (Object.hasOwn(messages, code) ? messages[code] : 'paused'))
}
export function requestProblem(error: unknown) {
  const code = apiErrorCode(error)
  return code ? moveProblem(code) : apiErrorReason(error)
}
