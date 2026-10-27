import { deleteJson, getJson, postJson } from '@/api/client'

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

const path = (serviceId: string) => `/api/agent-services/${encodeURIComponent(serviceId)}`

export const listServices = () => getJson<{ services: AgentService[]; checkedAt: string }>('/api/agent-services')
export const readServiceLog = (serviceId: string) => getJson<ServiceLog>(`${path(serviceId)}/log`)
/** The PID the confirmation showed goes back with the request; the server stops only that recorded process. */
export const stopService = (service: AgentService) =>
  postJson<{ status: 'stopped' | 'still_running' | 'already_stopped' }>(`${path(service.serviceId)}/stop`, { pid: service.pid })
export const deleteService = (serviceId: string) => deleteJson<{ status: 'deleted' }>(path(serviceId))
export const clearServiceLog = (serviceId: string) => deleteJson<{ status: 'cleared' }>(`${path(serviceId)}/log`)
