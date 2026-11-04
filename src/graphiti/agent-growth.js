import { getKnowledgeGraph } from './knowledge-graph-reads.js';

// What an FLA learned by doing (rec#78, slice 1): the reusable experiences it
// reported at checkpoints, with how often later tasks applied them. The
// Provider already counts uses and promotes a pending experience to
// agent_confirmed after enough distinct tasks; this read puts those in front
// of the person, who keeps or drops each one. Read-only, model-free, current
// versions only: a dropped experience leaves this list and stays in history.

const EXPERIENCE_TYPE = 'ReusableExperience';
const PAGE_LIMIT = 2000;
// A project graph larger than this many pages is read in part and says so.
const MAX_PAGES = 5;
const ITEM_LIMIT = 50;
// Used in at least this many tasks: proven, the order the person judges in.
const PROVEN_TASKS = 2;

// Waiting for the person first (promoted by use, then used but pending), then
// untried, then already kept; more tasks, more uses and later use first.
const ORDER = { agent_confirmed: 0, pending: 1, confirmed: 3 };
const rank = item => item.status === 'pending' && !item.uses ? 2 : ORDER[item.status] ?? 2;

export async function getAgentGrowth(application, { personalSpaceId, agentId, personalProjectId = null }, ownerReads = null) {
  const agent = personalProjectId ? null
    : (await application.listProjectAgents({ personalSpaceId })).find(candidate => candidate.agentId === agentId);
  // An Agent this space does not list has learned nothing here.
  const projectIds = personalProjectId ? [personalProjectId]
    : [...new Set((agent?.assignments ?? []).filter(assignment => assignment.status === 'active')
      .map(assignment => assignment.personalProjectId))];
  let partial = false;
  const items = [];
  for (const projectId of projectIds) {
    const read = await experiencesIn(application, personalSpaceId, projectId, agentId, ownerReads);
    partial ||= read.partial;
    items.push(...read.items);
  }
  items.sort((a, b) => rank(a) - rank(b) || b.tasks - a.tasks || b.uses - a.uses
    || String(b.lastUsedAt ?? '').localeCompare(String(a.lastUsedAt ?? '')));
  return { agentId, personalProjectIds: projectIds, partial,
    counts: { total: items.length, proven: items.filter(item => item.proven).length,
      kept: items.filter(item => item.status === 'confirmed').length },
    items: items.slice(0, ITEM_LIMIT) };
}

async function experiencesIn(application, spaceId, personalProjectId, agentId, ownerReads) {
  const items = [];
  let offset = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const graph = await getKnowledgeGraph(application, { spaceId, personalProjectId, limit: PAGE_LIMIT, offset }, ownerReads);
    for (const node of graph.nodes) {
      if (node.type !== EXPERIENCE_TYPE || node.invalid_at || (node.version_status ?? 'current') !== 'current'
          || node.confirmation_basis?.proposed_by?.label !== agentId) continue;
      items.push({ itemId: node.id, personalProjectId, title: node.name,
        solution: node.attributes?.solution ?? node.summary ?? '', boundary: node.attributes?.boundary ?? null,
        status: node.confirmation_status ?? 'pending', uses: node.qualified_use_count ?? 0,
        tasks: node.distinct_task_count ?? 0, proven: (node.distinct_task_count ?? 0) >= PROVEN_TASKS, lastUsedAt: node.last_used_at ?? null, createdAt: node.created_at ?? null,
        // What a person's 保留 confirms on: the reasons the FLA recorded with it.
        basis: node.confirmation_basis ?? null });
    }
    if (!graph.truncated || graph.next_offset == null) return { items, partial: false };
    offset = graph.next_offset;
  }
  return { items, partial: true };
}
