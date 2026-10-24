import { buildWritingTasteProfile } from './writing-taste-profile.js';

const MAX_GRAPH_PAGES = 20;

// ownerReads: the console's human-review port, so the person's profile keeps
// the preferences given to one FLA and their conflicts; without it the graph
// and the conflicts read as an Agent.
export async function getWritingTasteProfile(application, {
  personalSpaceId,
  personalProjectId = null,
  limit = 500
} = {}, ownerReads = null) {
  const [graph, conflictRecords] = await Promise.all([
    readPersonalGraph(application, { personalSpaceId, limit }, ownerReads),
    readPreferenceConflicts(application, personalSpaceId, ownerReads)
  ]);
  return buildWritingTasteProfile({
    graph,
    conflictRecords,
    personalSpaceId,
    personalProjectId
  });
}

async function readPreferenceConflicts(application, personalSpaceId, ownerReads) {
  const records = new Map();
  const pageSize = 500;
  const read = ownerReads
    ? offset => ownerReads.preferenceConflicts({ personalSpaceId, status: 'ai_pending', limit: pageSize, offset })
    : offset => application.personal.listPreferenceConflicts(personalSpaceId, 'ai_pending', pageSize, offset);
  for (let page = 0; page < MAX_GRAPH_PAGES; page++) {
    const items = await read(page * pageSize);
    if (!Array.isArray(items)) throw new Error('Invalid writing taste conflict history');
    const size = records.size;
    for (const item of items) records.set(item.id, item);
    if (items.length < pageSize) return [...records.values()];
    if (records.size === size) break;
  }
  throw new Error('Writing taste conflict history is incomplete. Reload before generating a profile.');
}

// Writing-taste maturity counts every durable rule, so a truncated first page
// would understate readiness forever. Follow the provider offset cursor until
// it stops, keeping the read bounded by MAX_GRAPH_PAGES.
async function readPersonalGraph(application, { personalSpaceId, limit }, ownerReads) {
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();
  let offset = 0;
  let truncated = false;
  const offsets = new Set([0]);
  for (let page = 0; page < MAX_GRAPH_PAGES; page += 1) {
    const result = await application.getKnowledgeGraph({
      spaceId: personalSpaceId,
      limit,
      offset
    }, ownerReads);
    appendUnique(nodes, seenNodes, result?.nodes);
    appendUnique(edges, seenEdges, result?.edges);
    truncated = Boolean(result?.truncated);
    const nextOffset = pageOffset(result?.next_offset ?? result?.nextOffset);
    if (!truncated) return { nodes, edges, truncated: false };
    if (nextOffset === null || offsets.has(nextOffset)) break;
    offsets.add(nextOffset);
    offset = nextOffset;
  }
  throw new Error('Writing taste history is incomplete. Reload before generating a profile.');
}

function appendUnique(target, seen, items) {
  for (const item of Array.isArray(items) ? items : []) {
    const id = item?.id;
    if (id === undefined || id === null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(item);
  }
}

function pageOffset(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
