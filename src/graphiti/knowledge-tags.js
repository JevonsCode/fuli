// The open tag vocabulary on the Provider (rec#5 section 3). This host only maps
// the request; reuse, scoping, identity and history are the Provider's rules.

const ROUTES = Object.freeze({
  resolve: 'resolve', metrics: 'metrics',
  create: 'create', add_alias: 'aliases', attach: 'attach', detach: 'detach'
});
const CHANGES = new Set(['create', 'add_alias', 'attach', 'detach']);

const BODIES = Object.freeze({
  resolve: input => ({ query: input.query, ...(input.limit ? { limit: input.limit } : {}) }),
  metrics: input => ({ include_all_projects: input.allProjects === true,
    ...(input.days ? { days: input.days } : {}) }),
  create: input => ({ name: input.name, description: input.description ?? null,
    namespace: input.namespace ?? null, language: input.language ?? null, reason: input.reason,
    distinct_from: input.distinctFrom ?? [], ...changedBy(input) }),
  add_alias: input => ({ tag_id: input.tagId, alias: input.alias, reason: input.reason, ...changedBy(input) }),
  attach: input => link(input),
  detach: input => link(input)
});

export function knowledgeTags(application, operation, input) {
  const body = Object.hasOwn(BODIES, operation) ? BODIES[operation] : null;
  if (!body) throw new TypeError(`Unknown knowledge tag operation: ${operation}`);
  return application.personal.knowledgeTags(ROUTES[operation], {
    personal_space_id: input.personalSpaceId, personal_project_id: input.personalProjectId ?? null,
    ...body(input)
  });
}

// A change names one of the four writes; reads never pass as a change.
export function knowledgeTagChange(action) {
  if (!CHANGES.has(action)) throw new TypeError(`Unknown knowledge tag operation: ${action}`);
  return action;
}

function link(input) {
  return { tag_id: input.tagId, item_kind: input.itemKind, item_id: input.itemId, ...changedBy(input) };
}

function changedBy(input) {
  return { operation_actor: input.operationActor ?? 'agent',
    ...(input.sourceApplication ? { source_application: input.sourceApplication } : {}) };
}
