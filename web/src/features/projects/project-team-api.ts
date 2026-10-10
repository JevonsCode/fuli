import { getJson } from '@/api/client'

export interface ProjectTeamPerson {
  agentId: string
  name: string
  employeeNumber: string | null
  occupationEmoji: string | null
  responsibility: string
  peerRole: boolean
  reportsToAgentId?: string | null
}

export interface ProjectTeam {
  personalProjectId: string
  status: 'ready' | 'no_lead' | 'lead_unavailable'
  lead: ProjectTeamPerson | null
  unavailableLead: { agentId: string; name: string | null } | null
  members: ProjectTeamPerson[]
  collaborators: ProjectTeamPerson[]
  peers: ProjectTeamPerson[]
  unavailableMemberIds: string[]
}

export function readProjectTeam(personalSpaceId: string, personalProjectId: string) {
  const query = new URLSearchParams({ personalSpaceId, personalProjectId })
  return getJson<ProjectTeam>(`/api/project-team?${query}`)
}
