import { getJson, postJson } from '@/api/client'

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

/**
 * One line of work inside the project, owned by one FLA (docs/workstreams.md).
 * `decidedBy` is 'user' when the person opened or confirmed it; a lead cannot
 * then change it.
 */
export interface ProjectWorkstream {
  assignmentId: string
  name: string
  terms: string[]
  ownerAgentId: string
  ownerName: string | null
  ownerOnProject: boolean
  decidedBy: 'user' | 'host'
  startedAt: string
  changedAt: string
  revision: number
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
  /** Absent on servers that do not divide a project into workstreams yet. */
  workstreams?: ProjectWorkstream[]
}

export function readProjectTeam(personalSpaceId: string, personalProjectId: string) {
  const query = new URLSearchParams({ personalSpaceId, personalProjectId })
  return getJson<ProjectTeam>(`/api/project-team?${query}`)
}

/** Opens a line of work for one member of this project. Local console only. */
export function openWorkstream(personalProjectId: string, body: {
  leadAgentId: string; terms: string[]; responsibility: string
}) {
  return postJson<unknown>('/api/standing-assignments', { personalProjectId, ...body })
}

/** Gives the line to another member of the same project, terms and all. */
export function moveWorkstream(assignmentId: string, body: {
  expectedRevision: number; projectId: string; leadAgentId: string
}) {
  return postJson<unknown>(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/reassign`, body)
}

/** Adds or removes the words that name the line. */
export function editWorkstreamTerms(assignmentId: string, body: {
  expectedRevision: number; addTerms?: string[]; removeTerms?: string[]
}) {
  return postJson<unknown>(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/terms`, body)
}

/** Ends the line from now on. Its record and every revision stay. */
export function endWorkstream(assignmentId: string, expectedRevision: number) {
  return postJson<unknown>(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/retire`,
    { expectedRevision })
}
