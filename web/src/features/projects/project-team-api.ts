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

/** An optional group under the lead (R-11): its sub-lead and the members reporting to them. */
export interface ProjectSubTeam {
  id: string
  name: string
  lead: ProjectTeamPerson | null
  unavailableLead: { agentId: string; name: string | null } | null
  members: ProjectTeamPerson[]
  unavailableMemberIds: string[]
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
  /** Absent on servers before R-11. */
  subTeams?: ProjectSubTeam[]
  subTeamSuggestion?: { suggested: boolean; memberCount: number; threshold: number }
}

export function readProjectTeam(personalSpaceId: string, personalProjectId: string) {
  const query = new URLSearchParams({ personalSpaceId, personalProjectId })
  return getJson<ProjectTeam>(`/api/project-team?${query}`)
}
