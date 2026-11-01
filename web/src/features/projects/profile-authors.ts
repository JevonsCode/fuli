import type { ProjectFieldAuthor } from '@/types'

// Who wrote a project profile field, as the chip beside its label shows it.
// Weights mirror the Provider's (src/graphiti/project-profile-authors.js).
const AUTHOR_WEIGHTS = { person: 100, both: 90, agent: 50 } as const

export interface AuthorChip {
  kind: ProjectFieldAuthor['kind']
  /** FLA portraits to show, in order; none for the person alone or an unnamed Agent. */
  agentIds: string[]
  /** The FLA's name, or null for FULI's own draft. */
  agentName: string | null
  weight: number
}

export function authorChip(author: ProjectFieldAuthor | undefined | null): AuthorChip | null {
  if (!author) return null
  return {
    kind: author.kind,
    agentIds: author.kind !== 'person' && author.agent_id ? [author.agent_id] : [],
    agentName: author.agent_name ?? null,
    weight: AUTHOR_WEIGHTS[author.kind],
  }
}
