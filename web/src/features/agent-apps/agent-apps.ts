import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// Agent apps as the console manages them (docs/agent-apps.md): FLAs build an
// app and submit immutable versions; the person approves, disables and
// removes them. A version runs only once the person confirmed it in FULI's
// own confirmation flow; a console approval does not stand in for it.
// Removal starts with the code; the data stays until the person deletes it.
const approvalSchema = z.looseObject({
  entrypoint: z.string().nullish(),
  presence: z.string().nullish(),
  verification: z.string().nullish(),
  trustMode: z.string().nullish(),
  approvedAt: z.string().nullish(),
})
const runSchema = z.looseObject({
  status: z.string(),
  reason: z.string().nullish(),
  message: z.string().nullish(),
})
const instanceSchema = z.looseObject({
  state: z.string(),
  mode: z.string().nullish(),
  version: z.string().nullish(),
  startedAt: z.string().nullish(),
  stoppedAt: z.string().nullish(),
  stopReason: z.string().nullish(),
  exit: z.looseObject({ category: z.string(), message: z.string().nullish(), code: z.number().nullish() }).optional(),
})
const appRowSchema = z.looseObject({
  appId: z.string(),
  agentId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  type: z.string().nullable(),
  status: z.string(),
  version: z.string().nullable(),
  pendingVersions: z.array(z.string()),
  approval: approvalSchema.nullable(),
  run: runSchema,
  instance: instanceSchema.nullable(),
  lastUsedAt: z.string().nullish(),
  dataBytes: z.number(),
  orphanDataDirectory: z.boolean().optional(),
})
const versionSchema = z.looseObject({
  version: z.string(),
  state: z.string(),
  digest: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  type: z.string(),
  permissions: z.unknown(),
  resident: z.unknown(),
  bytes: z.number().nullish(),
  submittedAt: z.string().nullish(),
  approval: approvalSchema.nullable(),
})
const eventSchema = z.looseObject({ action: z.string(), at: z.string(), actor: z.string().nullish() })
const appDetailSchema = z.looseObject({
  appId: z.string(),
  agentId: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.string().nullable(),
  run: runSchema,
  instance: instanceSchema.nullable(),
  dataBytes: z.number(),
  createdAt: z.string().nullish(),
  versions: z.array(versionSchema),
  history: z.array(eventSchema),
  orphanDataDirectory: z.boolean().optional(),
})
export type AgentAppRow = z.infer<typeof appRowSchema>
export type AgentAppDetail = z.infer<typeof appDetailSchema>
export type AgentAppVersion = z.infer<typeof versionSchema>

const appPath = (appId: string, action?: string) => `/api/agent-apps/${encodeURIComponent(appId)}${action ? `/${action}` : ''}`
const anyAnswer = shapeOf(z.looseObject({}))

export const listApps = (personalSpaceId: string) =>
  getJson(`/api/agent-apps?${new URLSearchParams({ personalSpaceId })}`, shapeOf(z.looseObject({ apps: z.array(appRowSchema) })))
export const readApp = (appId: string) => getJson(appPath(appId), shapeOf(appDetailSchema))
export const disableApp = (appId: string) => postJson(appPath(appId, 'disable'), {}, anyAnswer)
/** Step one of removal: the code goes, the data stays. */
export const deleteAppCode = (appId: string) => postJson(appPath(appId, 'delete-code'), {}, anyAnswer)

// The person's lifecycle actions on one app (local console only).
const lifecycleShape = shapeOf(z.looseObject({ status: z.string(), instance: instanceSchema.nullable() }))
export const startApp = (appId: string) => postJson(appPath(appId, 'start'), {}, lifecycleShape)
export const stopApp = (appId: string) => postJson(appPath(appId, 'stop'), {}, lifecycleShape)
export const restartApp = (appId: string) => postJson(appPath(appId, 'restart'), {}, lifecycleShape)
/** Opens FULI's own confirmation for this version in a window, where the person types the app's name. */
export const confirmApp = (appId: string, action: 'approve' | 'rollback', version: string) =>
  postJson(appPath(appId, 'confirm'), { action, version }, shapeOf(z.looseObject({ opened: z.boolean() })))

const exportShape = shapeOf(z.looseObject({ path: z.string(), files: z.number(), bytes: z.number() }))
export const exportAppData = (appId: string) => postJson(appPath(appId, 'export'), {}, exportShape)
export const revealAppExport = (appId: string, path: string) => postJson(appPath(appId, 'reveal-export'), { path }, anyAnswer)

const deletionOfferSchema = z.looseObject({ ticket: z.string(), expiresAt: z.string(), dataBytes: z.number(), dataFiles: z.number() })
export type DataDeletionOffer = z.infer<typeof deletionOfferSchema>
/** Step two begins: a short-lived ticket for the data exactly as it is now. */
export const offerDataDeletion = (appId: string) => postJson(appPath(appId, 'data-deletion'), {}, shapeOf(deletionOfferSchema))
/** Step two ends: the data goes, confirmed with the app id and the offer's ticket. */
export const deleteAppData = (appId: string, ticket: string) => postJson(appPath(appId, 'delete-data'), { ticket, confirm: appId }, anyAnswer)

/** What lets this app run: approve its newest waiting version, or confirm the active one again. */
export function confirmationStep(app: Pick<AgentAppRow, 'status' | 'version' | 'pendingVersions' | 'run'>): { action: 'approve' | 'rollback'; version: string } | null {
  const pending = app.pendingVersions.at(-1)
  if (pending) return { action: 'approve', version: pending }
  if (app.status === 'active' && app.version && app.run.status === 'run_refused'
    && ['confirmation_required', 'reconfirmation_required', 'challenge_mismatch'].includes(app.run.reason ?? '')) {
    return { action: 'rollback', version: app.version }
  }
  return null
}

/** Where a page app is served to the console: a sandboxed iframe only, never same-origin. */
export const appPageUrl = (appId: string) => `/app-pages/${encodeURIComponent(appId)}/`
