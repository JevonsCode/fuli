import { projectExperiences } from '../graphiti/agent-growth.js';

// A project's acceptance list grown from use (rec#78, 11-06 addition 2): the
// lessons its FLAs learned that can be checked (an acceptance item or a
// regression example) and that the person kept. They are not stored apart:
// each is the current version of a kept experience, so a dropped or replaced
// lesson leaves the list and its history stays with the experience. Tonborg's
// acceptance and Jefa's task read take a few on demand; nothing is injected.
// occupation is the learning FLA's occupation, so an occupation's criteria
// (occupation plugins) can be merged with what its FLAs learned.
const DEFAULT_LIMIT = 10;

export async function projectAcceptanceChecks(application, { personalSpaceId, personalProjectId, occupation = null, limit = DEFAULT_LIMIT },
  ownerReads = null) {
  const { items: kept } = await projectExperiences(application, personalSpaceId, personalProjectId,
    node => node.confirmation_status === 'confirmed' && Boolean(node.attributes?.check?.text), ownerReads);
  if (!kept.length) return { checks: [] };
  const occupations = new Map((await application.listProjectAgents({ personalSpaceId }))
    .map(agent => [agent.agentId, agent.occupation?.role ?? null]));
  const checks = kept.map(item => ({ checkId: item.itemId, kind: item.check.kind, text: item.check.text,
    occupation: occupations.get(item.proposedBy) ?? null, personalProjectId, sourceAgentId: item.proposedBy,
    keptAt: item.basis?.confirmed_at ?? null }))
    .filter(check => occupation === null || check.occupation === occupation)
    .sort((left, right) => String(right.keptAt ?? '').localeCompare(String(left.keptAt ?? '')));
  return { checks: checks.slice(0, limit) };
}

// What a reader passes on: kind and text of a few. A list that cannot be read
// adds nothing and stops nothing (an assessment or a task read goes on).
export async function briefAcceptanceChecks(application, { personalSpaceId, personalProjectId, limit = DEFAULT_LIMIT }) {
  try {
    return (await projectAcceptanceChecks(application, { personalSpaceId, personalProjectId, limit })).checks
      .map(({ kind, text }) => ({ kind, text }));
  } catch {
    return [];
  }
}
