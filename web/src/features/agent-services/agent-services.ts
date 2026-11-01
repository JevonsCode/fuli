import { z } from 'zod'
import { deleteJson, getJson, postJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'

// 服务管理: the services FULI Agents started, as /api/agent-services returns
// them, with their live state checked on every read (rec#11 D-71).
export type ServiceKind = 'workbench' | 'agent_service'
export type ServiceLiveState = 'running' | 'stopped' | 'unknown'
export type ServiceProcessState = 'alive' | 'gone' | 'replaced' | 'unverified' | 'unknown'
export type ServicePortState = 'open' | 'closed' | 'not_checked'

export interface AgentService {
  serviceId: string
  kind: ServiceKind
  personalSpaceId: string | null
  agentId: string | null
  projectId: string | null
  client: string | null
  sessionId: string | null
  appId: string | null
  address: string | null
  purpose: string
  command: string | null
  pid: number | null
  executable: string | null
  commandLine: string | null
  state: 'running' | 'stopped'
  startedAt: string
  stoppedAt: string | null
  stopReason: string | null
  live: { state: ServiceLiveState; process: ServiceProcessState | null; port: ServicePortState }
}

export interface ServiceLogEntry {
  id: number
  at: string
  action: string
  actor: 'agent' | 'person' | 'fuli'
  detail: Record<string, unknown> | null
}

export interface ServiceLog { serviceId: string; entries: ServiceLogEntry[]; liveOutput: string | null }

// What the services page reads of each record; the rest passes through. The
// store keeps every column, so an unset one arrives as null.
const serviceShape = z.looseObject({
  serviceId: z.string(),
  kind: z.string(),
  agentId: z.string().nullish(),
  projectId: z.string().nullish(),
  client: z.string().nullish(),
  sessionId: z.string().nullish(),
  address: z.string().nullish(),
  purpose: z.string(),
  command: z.string().nullish(),
  pid: z.number().nullish(),
  commandLine: z.string().nullish(),
  startedAt: z.string(),
  live: z.looseObject({ state: z.string(), process: z.string().nullish(), port: z.string().nullish() }),
})
const listShape = shapeFor<{ services: AgentService[]; checkedAt: string }>(z.looseObject({
  services: z.array(serviceShape),
  checkedAt: z.string(),
}))
const logShape = shapeFor<ServiceLog>(z.looseObject({
  serviceId: z.string(),
  entries: z.array(z.looseObject({ id: z.number(), at: z.string(), action: z.string(), actor: z.string() })),
  liveOutput: z.string().nullish(),
}))
const stopShape = shapeFor<{ status: 'stopped' | 'still_running' | 'already_stopped' }>(z.looseObject({ status: z.string() }))
const deletedShape = shapeFor<{ status: 'deleted' }>(z.looseObject({ status: z.string() }))
const clearedShape = shapeFor<{ status: 'cleared' }>(z.looseObject({ status: z.string() }))

const path = (serviceId: string) => `/api/agent-services/${encodeURIComponent(serviceId)}`

export const listServices = () => getJson('/api/agent-services', listShape)
export const readServiceLog = (serviceId: string) => getJson(`${path(serviceId)}/log`, logShape)
/** The PID the confirmation showed goes back with the request; the server stops only that recorded process. */
export const stopService = (service: AgentService) =>
  postJson(`${path(service.serviceId)}/stop`, { pid: service.pid }, stopShape)
export const deleteService = (serviceId: string) => deleteJson(path(serviceId), undefined, deletedShape)
export const clearServiceLog = (serviceId: string) => deleteJson(`${path(serviceId)}/log`, undefined, clearedShape)
