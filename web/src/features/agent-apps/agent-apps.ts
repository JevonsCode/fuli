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
