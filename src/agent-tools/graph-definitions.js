import {
  arraySchema,
  booleanSchema,
  enumSchema,
  integerSchema,
  nullableStringSchema,
  numberSchema,
  objectSchema,
  stringSchema
} from './schema.js';

const id = boundedString(256);
const label = boundedString(512);
const shortText = boundedString(2048);
const longText = boundedString(8192);
const dateTime = { ...boundedString(64), format: 'date-time' };
const attributes = { type: 'object', additionalProperties: true };
const epistemicQuadrant = enumSchema([
  'known_known', 'known_unknown', 'unknown_known', 'unknown_unknown'
]);
const epistemicStatus = enumSchema(['confirmed', 'observed', 'exploratory']);
const confirmationStatus = enumSchema(['confirmed', 'pending']);
const confirmationActor = objectSchema({
  kind: enumSchema(['user', 'agent', 'authoritative_source', 'import']),
  label: nullableStringSchema()
}, ['kind']);
const confirmationBasis = objectSchema({
  existenceReason: boundedString(4096),
  quadrantReason: boundedString(4096),
  proposedBy: confirmationActor,
  confirmedBy: { ...confirmationActor, type: ['object', 'null'] },
  confirmedAt: nullableStringSchema()
}, ['existenceReason', 'quadrantReason', 'proposedBy']);
const knowledgeItemKind = enumSchema(['entity', 'relationship']);
const humanChangeStatus = enumSchema([
  'all', 'human_changed', 'unseen', 'viewed', 'reviewed'
]);
const projectRelationType = enumSchema([
  'PART_OF', 'DEPENDS_ON', 'PROVIDES_TO', 'SHARES_CAPABILITY_WITH',
  'SUCCESSOR_OF', 'RELATED_TO'
]);
const knowledgeConflictResolution = enumSchema([
  'defer', 'keep_target', 'use_source', 'coexist'
]);
const profileAspect = {
  type: ['string', 'null'],
  enum: ['taste', 'personality', 'judgment_preference', null]
};
const sourceApplication = {
  type: ['string', 'null'],
  enum: ['codex', 'claude_code', 'cursor', 'kiro', 'other', null]
};
const epistemicFields = {
  originQuadrant: epistemicQuadrant,
  currentQuadrant: epistemicQuadrant,
  epistemicStatus,
  confirmationStatus,
  confirmationBasis,
  reasoningSummary: nullableStringSchema(),
  profileAspect
};

const entity = objectSchema({
  key: id,
  name: label,
  type: { ...boundedString(64), pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
  summary: boundedString(4096),
  ...epistemicFields,
  attributes
}, [
  'key', 'name', 'type', 'originQuadrant',
  'confirmationStatus', 'confirmationBasis'
]);

const relationship = objectSchema({
  key: id,
  source: id,
  target: id,
  type: { ...boundedString(64), pattern: '^[A-Z][A-Z0-9_]*$' },
  fact: longText,
  validAt: nullableStringSchema(),
  invalidAt: nullableStringSchema(),
  supersedes: arraySchema(id, { maxItems: 32 }),
  confidence: numberSchema({ minimum: 0, maximum: 1 }),
  ...epistemicFields,
  attributes
}, [
  'key', 'source', 'target', 'type', 'fact', 'originQuadrant',
  'confirmationStatus', 'confirmationBasis'
]);

const projectSource = objectSchema({
  key: boundedString(128),
  kind: enumSchema([
    'prd', 'product_document', 'technical_document', 'frontend_repository',
    'backend_repository', 'repository', 'design', 'runbook', 'monitoring',
    'issue_tracker', 'other'
  ]),
  title: label,
  uri: nullableStringSchema(),
  summary: nullableStringSchema(),
  sensitivity: enumSchema(['normal', 'private', 'restricted'])
}, ['key', 'kind', 'title']);

const assessmentDimension = objectSchema({
  key: boundedString(128),
  label: boundedString(256),
  score: integerSchema({ minimum: 0, maximum: 100 }),
  state: enumSchema(['confirmed', 'inferred']),
  evidence: arraySchema(shortText, { maxItems: 32 })
}, ['key', 'label', 'score', 'state']);

const projectAssessment = objectSchema({
  score: integerSchema({ minimum: 0, maximum: 100 }),
  label: enumSchema(['needs_clarification', 'partially_documented', 'well_documented']),
  confirmed: arraySchema(shortText, { maxItems: 64 }),
  inferred: arraySchema(shortText, { maxItems: 64 }),
  dimensions: arraySchema(assessmentDimension, { maxItems: 16 }),
  analyzedAt: dateTime
}, ['score', 'label', 'confirmed', 'inferred', 'dimensions', 'analyzedAt']);

const projectProfile = objectSchema({
  name: boundedString(160),
  purpose: nullableStringSchema(),
  scope: nullableStringSchema(),
  technicalSummary: nullableStringSchema(),
  lifecycle: enumSchema(['planned', 'active', 'maintenance', 'archived']),
  sources: arraySchema(projectSource, { maxItems: 64 }),
  boundaries: arraySchema(shortText, { maxItems: 64 }),
  assessment: { ...projectAssessment, type: ['object', 'null'] }
}, ['name']);

export const GRAPH_TOOL_DEFINITIONS = [
  {
    name: 'get_collaboration_preferences',
    description: 'Call at the start of every user task before any other tool or answer. Pass projectPath as the current working directory; Fuli uses it transiently, never stores or returns it, and layers preferences only for one exact registered local project match. Returns effective_preferences plus deferred_conflicts intentionally queued for AI. Apply effective_preferences before answering or constructing tool arguments. If the current task would use a deferred conflict, call resolve_deferred_preference_conflict before applying either side; ignore unrelated deferred conflicts. For write tools, enforce preferences in the actual payload; mentioning them only in the final answer is not compliance. Personal-global preferences always apply; other conflicted, pending, invalid, ambiguous-project, and unrelated-project items never apply. personalProjectId remains an explicit compatibility override.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      personalProjectId: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 200 })
    }, ['projectPath'])
  },
  {
    name: 'resolve_deferred_preference_conflict',
    description: 'Resolve one AI-deferred collaboration-preference conflict returned by get_collaboration_preferences when, and only when, the current task needs that preference. Compare both confirmed sides against their evidence and the current context before choosing. The operation updates the effective knowledge, preserves revision history, and permanently marks the conflict as previously conflicted and resolved by AI. Use merge with a canonical item and merged instruction, keep_left or keep_right to retain one side, or split_scope to move one side to an exact personal project.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      conflictId: boundedString(1024),
      resolution: enumSchema([
        'merge', 'keep_left', 'keep_right', 'split_scope'
      ]),
      reason: shortText,
      canonicalItemId: nullableStringSchema(),
      mergedInstruction: nullableStringSchema(),
      splitItemId: nullableStringSchema(),
      splitProjectId: nullableStringSchema()
    }, ['personalSpaceId', 'conflictId', 'resolution', 'reason'])
  },
  {
    name: 'capture_session_knowledge',
    description: 'Silently batch durable session knowledge when the user-enabled capture policy allows it. Every item records its discovery quadrant, structured confirmation basis, and pending or confirmed state. A disabled policy returns capture_disabled without writing. Personal profile knowledge stays personal; only project knowledge with an auditable confirmation can enter public review.',
    inputSchema: objectSchema({
      targetKind: enumSchema(['personal', 'project']),
      spaceId: id,
      personalProjectId: nullableStringSchema(),
      providerUrl: nullableStringSchema(),
      idempotencyKey: id,
      sessionId: id,
      name: label,
      sourceKind: boundedString(128),
      sourceDescription: boundedString(1024),
      sourceApplication,
      sourceTurnId: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
      sourceExcerpt: { type: ['string', 'null'], minLength: 1, maxLength: 2048 },
      referenceTime: dateTime,
      summary: longText,
      sensitivity: enumSchema(['normal', 'private', 'restricted']),
      entities: arraySchema(entity, { minItems: 1, maxItems: 128 }),
      relationships: arraySchema(relationship, { maxItems: 256 })
    }, [
      'targetKind', 'spaceId', 'idempotencyKey', 'sessionId', 'name',
      'sourceKind', 'sourceDescription', 'referenceTime', 'entities', 'relationships'
    ])
  },
  {
    name: 'search_knowledge_graph',
    description: 'Search durable context before saying you do not know when a task may depend on remembered URLs, routes, requirements, architecture, prior decisions, runbooks, rationale, or personal preferences. The bounded scope includes the personal-global profile, exact active local project, explicitly selected additional personal projects, and selected subscribed team projects. Use all_local_confirmed only after explicit user confirmation; it searches registered local personal projects for this query and never expands public projects. If that still has no support, use read-only local file search in the current repository or workspace files within a safe root. The response includes sourceMarker for supporting results, noMatchSourceMarker when returned items do not support the answer, and retrievalGuidance with the required next action.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      query: shortText,
      personalProjectId: nullableStringSchema(),
      contextPersonalProjectIds: arraySchema(id, { maxItems: 15 }),
      personalProjectScope: enumSchema(['bounded', 'all_local_confirmed']),
      projectIds: arraySchema(id, { maxItems: 32 }),
      limit: integerSchema({ minimum: 1, maximum: 100 }),
      includeHistorical: booleanSchema(),
      includePending: booleanSchema()
    }, ['personalSpaceId', 'query'])
  },
  {
    name: 'get_knowledge_graph',
    description: 'Return a bounded node-edge graph for a personal space, one exact local personal project, or a team-shared project.',
    inputSchema: objectSchema({
      spaceId: id,
      providerUrl: nullableStringSchema(),
      personalProjectId: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 2000 })
    }, ['spaceId'])
  },
  {
    name: 'search_human_knowledge_changes',
    description: 'Search the permanent audit trail for personal knowledge changed by a human. Filter by unseen (not yet read by an Agent), viewed (read but still awaiting conflict and classification review), or reviewed. Returning an item records this Agent view but does not clear its pending marker.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      query: shortText,
      status: humanChangeStatus,
      limit: integerSchema({ minimum: 1, maximum: 200 })
    }, ['personalSpaceId'])
  },
  {
    name: 'review_human_knowledge_change',
    description: 'Submit an explicit review for the current version of one human-edited personal knowledge item. The pending marker clears only when the Agent reports both no conflict and reasonable classification. Stale versions and items not read by an Agent are rejected; every review remains in the audit trail.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      itemKind: knowledgeItemKind,
      itemId: id,
      humanChangeVersion: integerSchema({ minimum: 1 }),
      conflictCheck: enumSchema(['no_conflict', 'conflict']),
      classificationCheck: enumSchema(['reasonable', 'needs_change']),
      note: boundedString(2000)
    }, [
      'personalSpaceId', 'itemKind', 'itemId', 'humanChangeVersion',
      'conflictCheck', 'classificationCheck', 'note'
    ])
  },
  {
    name: 'list_knowledge_spaces',
    description: 'List the active personal space, accessible team-shared projects, and current subscriptions.',
    inputSchema: objectSchema({})
  },
  {
    name: 'upsert_personal_project',
    description: 'Create or update a local personal project profile, including evidence sources and an explainable display-only summary of evidence already present. Do not generate missing-item claims. This never publishes the project.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      projectId: boundedString(128),
      profile: projectProfile
    }, ['personalSpaceId', 'projectId', 'profile'])
  },
  {
    name: 'list_personal_projects',
    description: 'List local personal project profiles and their current evidence-backed coverage summaries.',
    inputSchema: objectSchema({ personalSpaceId: id })
  },
  {
    name: 'revise_personal_knowledge',
    description: 'Correct, invalidate, or restore one personal entity or relationship while preserving revision history and original evidence. This is the same personal-only operation used by the management UI.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      itemKind: knowledgeItemKind,
      itemId: id,
      action: enumSchema(['update', 'invalidate', 'restore']),
      reason: shortText,
      name: nullableStringSchema(),
      summary: nullableStringSchema(),
      fact: nullableStringSchema(),
      originQuadrant: epistemicQuadrant,
      currentQuadrant: epistemicQuadrant,
      epistemicStatus,
      confirmationStatus,
      confirmationBasis,
      reasoningSummary: nullableStringSchema(),
      profileAspect
    }, ['personalSpaceId', 'itemKind', 'itemId', 'action', 'reason'])
  },
  {
    name: 'reassign_personal_knowledge',
    description: 'Move the primary project assignment of one personal knowledge item without rewriting its source episode or evidence. Personal-profile knowledge cannot be assigned to a project.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      itemKind: knowledgeItemKind,
      itemId: id,
      targetProjectId: boundedString(128),
      reason: shortText
    }, ['personalSpaceId', 'itemKind', 'itemId', 'targetProjectId', 'reason'])
  },
  {
    name: 'set_personal_preference_scope',
    description: 'Change one taste, personality, or judgment preference between the default personal-global scope and one exact personal project. The source evidence remains unchanged and the scope change is recorded in revision history.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      itemKind: knowledgeItemKind,
      itemId: id,
      scope: enumSchema(['global', 'project']),
      projectId: nullableStringSchema(),
      reason: shortText
    }, ['personalSpaceId', 'itemKind', 'itemId', 'scope', 'reason'])
  },
  {
    name: 'preview_personal_project_action',
    description: 'Preview adding one personal entity to an existing personal project. Reports exact duplicates and confirmed same-name conflicts before any write.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      itemKind: enumSchema(['entity']),
      itemId: id,
      targetProjectId: boundedString(128)
    }, ['personalSpaceId', 'itemKind', 'itemId', 'targetProjectId'])
  },
  {
    name: 'apply_personal_project_action',
    description: 'Create a private personal project from one entity or add the entity to an existing personal project. Existing ownership and evidence are preserved through references; duplicates are reused and conflicts follow the explicit resolution. When creating from a project-scoped node, directional relations run from the new extracted project to the original source project, so PART_OF creates the expected child-to-parent link. Agents can repeat this operation for source-backed related PRD or code entities.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      itemKind: enumSchema(['entity']),
      itemId: id,
      mode: enumSchema(['create', 'existing']),
      targetProjectId: nullableStringSchema(),
      newProjectId: nullableStringSchema(),
      newProjectName: nullableStringSchema(),
      newProjectPurpose: nullableStringSchema(),
      keepSourceRelation: booleanSchema(),
      relationType: projectRelationType,
      conflictResolution: knowledgeConflictResolution,
      reason: shortText
    }, ['personalSpaceId', 'itemKind', 'itemId', 'mode', 'reason'])
  },
  {
    name: 'publish_personal_project',
    description: 'Publish or synchronize one local personal project to a configured public Provider with an immutable release version and update summary. The Provider records the authenticated publisher and server publication time. The first publisher becomes Owner and Maintainer and is automatically subscribed. Evidence coverage never blocks publication.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      localProjectId: boundedString(128),
      providerUrl: shortText,
      releaseVersion: { ...boundedString(64), pattern: '^[0-9A-Za-z][0-9A-Za-z._-]*$' },
      updateSummary: boundedString(4096)
    }, [
      'personalSpaceId', 'localProjectId', 'providerUrl',
      'releaseVersion', 'updateSummary'
    ])
  },
  {
    name: 'list_project_releases',
    description: 'List immutable public project releases including version, publisher, publication time, and update summary.',
    inputSchema: objectSchema({
      projectId: id,
      providerUrl: shortText
    }, ['projectId', 'providerUrl'])
  },
  {
    name: 'create_project_relation',
    description: 'Create a canonical relationship between two public projects. PART_OF waits for target/parent Maintainer confirmation; other relation types become active immediately. This never subscribes either project.',
    inputSchema: objectSchema({
      sourceProjectId: id,
      targetProjectId: id,
      providerUrl: shortText,
      relationType: projectRelationType,
      note: nullableStringSchema()
    }, ['sourceProjectId', 'targetProjectId', 'providerUrl', 'relationType'])
  },
  {
    name: 'list_project_relations',
    description: 'List canonical incoming and outgoing project relationships. Related projects are suggestions only and never expand the active subscription set.',
    inputSchema: objectSchema({
      projectId: id,
      providerUrl: shortText
    }, ['projectId', 'providerUrl'])
  },
  {
    name: 'review_project_relation',
    description: 'Confirm or reject a pending PART_OF relationship as a Maintainer of the target parent project.',
    inputSchema: objectSchema({
      targetProjectId: id,
      relationId: id,
      providerUrl: shortText,
      decision: enumSchema(['confirm', 'reject']),
      note: nullableStringSchema()
    }, ['targetProjectId', 'relationId', 'providerUrl', 'decision'])
  },
  {
    name: 'list_personal_review_queue',
    description: 'List full structured knowledge drafts waiting in the local personal pre-review queue before any public submission.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      status: enumSchema(['pending', 'submitted', 'kept_personal', 'ignored'])
    }, ['personalSpaceId'])
  },
  {
    name: 'review_personal_draft',
    description: 'Decide a local pre-review draft: submit it to shared Maintainer review, keep it only in the personal graph, or ignore it. No background upload occurs.',
    inputSchema: objectSchema({
      draftId: id,
      decision: enumSchema(['submit_public', 'keep_personal', 'ignore'])
    }, ['draftId', 'decision'])
  },
  {
    name: 'subscribe_public_project',
    description: 'Subscribe the active personal graph to an accessible team-shared project.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      projectId: id,
      providerUrl: shortText,
      projectName: label
    }, ['personalSpaceId', 'projectId', 'providerUrl', 'projectName'])
  },
  {
    name: 'unsubscribe_public_project',
    description: 'Stop including one subscribed team-shared project in the active personal context. This removes only the local subscription and never deletes the public project.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      projectId: id,
      providerUrl: shortText
    }, ['personalSpaceId', 'projectId', 'providerUrl'])
  },
  {
    name: 'list_project_review_queue',
    description: 'List pending structured knowledge proposals for a team-shared project. Maintainer role is required.',
    inputSchema: objectSchema({
      projectId: id,
      providerUrl: shortText,
      status: enumSchema(['pending', 'approved', 'rejected'])
    }, ['projectId', 'providerUrl'])
  },
  {
    name: 'review_project_proposal',
    description: 'Approve or reject one team-shared project knowledge proposal. Maintainer role is required.',
    inputSchema: objectSchema({
      projectId: id,
      providerUrl: shortText,
      proposalId: id,
      decision: enumSchema(['approve', 'reject']),
      note: boundedString(2000)
    }, ['projectId', 'providerUrl', 'proposalId', 'decision'])
  },
  {
    name: 'get_graphiti_status',
    description: 'Return health and storage mode for the personal and configured workspace providers.',
    inputSchema: objectSchema({})
  }
];

function boundedString(maxLength) {
  return { ...stringSchema(), minLength: 1, maxLength };
}
