import { z } from 'zod'

import { getJson, postJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'

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

/** How far a line got: its latest task, from the owner's work log. */
export interface WorkstreamTask {
  status: string | null
  summary: string | null
  at: string | null
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
  /** null: no task of this line yet. Absent on a read that did not ask how far it got. */
  latestTask?: WorkstreamTask | null
  /** The owner's work log could not be read, so how far it got is unknown. */
  progressUnreadable?: boolean
}

/** A line that was merged or ended: it routes nothing; its record and revisions stay. */
export interface ClosedWorkstream {
  assignmentId: string
  name: string
  terms: string[]
  ownerAgentId: string
  ownerName: string | null
  startedAt: string
  endedAt: string
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
  /** Only on this computer; absent over the LAN and on older servers. */
  workstreams?: ProjectWorkstream[]
}

const person = z.object({ agentId: z.string(), name: z.string() })
const projectTeamShape = shapeFor<ProjectTeam>(z.object({
  personalProjectId: z.string(),
  status: z.enum(['ready', 'no_lead', 'lead_unavailable']),
  lead: person.nullable(),
  members: z.array(person),
  collaborators: z.array(person),
  peers: z.array(person),
}))

// What the ledger shows of a line, as src/graphiti/workstream-ledger.js sends it; anything else is dropped.
const workstreamTask = z.object({ status: z.string().nullable(), summary: z.string().nullable(), at: z.string().nullable() })
const workstreamLine = z.object({ assignmentId: z.string(), name: z.string(), terms: z.array(z.string()),
  ownerAgentId: z.string(), ownerName: z.string().nullish(), ownerOnProject: z.boolean(), revision: z.number(),
  latestTask: workstreamTask.nullish(), progressUnreadable: z.boolean().optional() })
const closedLine = z.object({ assignmentId: z.string(), name: z.string(), terms: z.array(z.string()),
  ownerAgentId: z.string(), ownerName: z.string().nullish(), endedAt: z.string() })
const projectWorkstreamsShape = shapeFor<{ personalProjectId: string; workstreams: ProjectWorkstream[];
  closed?: ClosedWorkstream[] }>(z.object({ personalProjectId: z.string(), workstreams: z.array(workstreamLine),
  // Absent on servers before the ended lines were listed.
  closed: z.array(closedLine).optional() }))

/** One FLA's ledger: the lines of the projects it leads, and the lines it owns. */
export interface AgentWorkstreamLedger {
  agentId: string
  projects: {
    projectId: string
    projectName: string
    /** True when this FLA leads the project, so the group is its whole ledger. */
    leads: boolean
    workstreams: ProjectWorkstream[]
  }[]
}

const agentWorkstreamsShape = shapeFor<AgentWorkstreamLedger>(z.object({
  agentId: z.string(),
  projects: z.array(z.object({ projectId: z.string(), projectName: z.string(), leads: z.boolean(),
    workstreams: z.array(workstreamLine) })),
}))

// The pieces of one project page mount together and read the team in the same
// tick; they share that one request instead of sending one each. Any later
// read, a refresh included, asks again, so a slow or lost answer never stands
// in for a fresh one.
const teamReads = new Map<string, Promise<ProjectTeam>>()

export function readProjectTeam(personalSpaceId: string, personalProjectId: string) {
  const key = `${personalSpaceId}\u0000${personalProjectId}`
  const pending = teamReads.get(key)
  if (pending) return pending
  const query = new URLSearchParams({ personalSpaceId, personalProjectId })
  const read = getJson(`/api/project-team?${query}`, projectTeamShape)
  teamReads.set(key, read)
  queueMicrotask(() => teamReads.delete(key))
  return read
}

/** A project's lines with how far each got, and its ended ones. This computer only. */
export function readProjectWorkstreams(personalProjectId: string) {
  return getJson(`/api/workstreams?${new URLSearchParams({ personalProjectId })}`, projectWorkstreamsShape)
}

export function readAgentWorkstreams(agentId: string) {
  return getJson(`/api/workstreams?${new URLSearchParams({ agentId })}`, agentWorkstreamsShape)
}

/** Opens a line of work for one member of this project. */
export function openWorkstream(personalProjectId: string, body: {
  leadAgentId: string; terms: string[]; responsibility: string
}) {
  return postJson('/api/standing-assignments', { personalProjectId, ...body })
}

/** Gives the line to another member of the same project, terms and all. */
export function moveWorkstream(assignmentId: string, body: {
  expectedRevision: number; projectId: string; leadAgentId: string
}) {
  return postJson(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/reassign`, body)
}

/** Adds or removes the words that name the line. */
export function editWorkstreamTerms(assignmentId: string, body: {
  expectedRevision: number; addTerms?: string[]; removeTerms?: string[]
}) {
  return postJson(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/terms`, body)
}

/** This line's words move into another line and this one ends, as one change. */
export function mergeWorkstream(assignmentId: string, body: {
  into: string; expectedRevision: number; targetRevision: number
}) {
  return postJson(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/merge`, body)
}

/** Some words leave this line for a new line of another member, as one change. */
export function splitWorkstream(assignmentId: string, body: {
  expectedRevision: number; terms: string[]; extraTerms: string[]; leadAgentId: string; responsibility: string
}) {
  return postJson(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/split`, body)
}

/** Ends the line from now on. Its record and every revision stay. */
export function endWorkstream(assignmentId: string, expectedRevision: number) {
  return postJson(`/api/standing-assignments/${encodeURIComponent(assignmentId)}/retire`, { expectedRevision })
}
