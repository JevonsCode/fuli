import { KNOWLEDGE_USAGE_DEFINITION } from './knowledge-usage-definitions.js';
import { KNOWLEDGE_TAG_DEFINITIONS } from './knowledge-tag-definitions.js';
import {
  confirmationBasis,
  confirmationStatus,
  dateTime,
  epistemicQuadrant,
  epistemicStatus,
  id,
  inheritanceMode,
  knowledgeItemKind,
  label,
  profileAspect,
  shortText,
  sourceApplication
} from './graph-tool-fields.js';
import {
  arraySchema,
  booleanSchema,
  boundedString,
  enumSchema,
  integerSchema,
  nullableStringSchema,
  numberSchema,
  objectSchema
} from './schema.js';

const longText = boundedString(8192);
const sourceUri = {
  type: ['string', 'null'],
  minLength: 1,
  maxLength: 2048,
  pattern: '^[Hh][Tt][Tt][Pp][Ss]?://\\S+$'
};
const attributes = { type: 'object', additionalProperties: true };
const entityAttributes = {
  type: 'object',
  properties: {
    searchTerms: arraySchema(boundedString(256), { minItems: 1, maxItems: 32 })
  },
  additionalProperties: true
};
const decisionActor = objectSchema({
  kind: enumSchema(['user', 'agent', 'authoritative_source']),
  label: nullableStringSchema()
}, ['kind']);
const humanChangeStatus = enumSchema([
  'all', 'human_changed', 'unseen', 'viewed', 'reviewed'
]);
const epistemicFields = {
  originQuadrant: epistemicQuadrant,
  currentQuadrant: epistemicQuadrant,
  epistemicStatus,
  confirmationStatus,
  confirmationBasis,
  reasoningSummary: {
    ...nullableStringSchema(),
    description: 'Required and nonempty whenever originQuadrant is not known_known. Explain how the item became known; omitting it rejects the whole batch.'
  },
  profileAspect,
  inheritanceMode,
  inheritedProjectIds: arraySchema(id, { maxItems: 32 })
};

// rec#5 C8-4: once one of them is marked outdated, the conclusion is no longer current.
const derivedFrom = { ...arraySchema(id, { maxItems: 8 }), description: 'Current item IDs this concludes from.' };

const entity = objectSchema({
  key: id,
  name: label,
  type: { ...boundedString(64), pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
  summary: boundedString(4096),
  ...epistemicFields,
  derivedFrom,
  attributes: entityAttributes
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
  derivedFrom,
  attributes
}, [
  'key', 'source', 'target', 'type', 'fact', 'originQuadrant',
  'confirmationStatus', 'confirmationBasis'
]);

const commonKnowledgePromotionIntent = {
  personalSpaceId: id,
  parentProjectId: id,
  itemKind: knowledgeItemKind,
  canonicalItemId: id,
  duplicateItemIds: arraySchema(id, { minItems: 1, maxItems: 31 }),
  reason: boundedString(2000),
  humanConfirmationReason: boundedString(2000)
};
const commonKnowledgePromotionRequired = [
  'personalSpaceId', 'parentProjectId', 'itemKind', 'canonicalItemId',
  'duplicateItemIds', 'reason', 'humanConfirmationReason'
];
const personalGlobalPreferenceDecisionIntent = {
  personalSpaceId: id,
  candidateId: {
    ...boundedString(64),
    pattern: '^personal-global-[a-f0-9]{20}$'
  },
  candidateVersion: {
    ...boundedString(32),
    pattern: '^v1:[a-f0-9]{24}$'
  },
  decisionRevision: integerSchema({ minimum: 0 }),
  decision: enumSchema(['approve', 'reject']),
  sourceItems: arraySchema(objectSchema({
    itemId: id,
    itemKind: knowledgeItemKind,
    projectId: id
  }, ['itemId', 'itemKind', 'projectId']), { minItems: 2, maxItems: 32 }),
  preferenceKey: boundedString(512),
  targetScope: enumSchema(['parent_project', 'personal_global']),
  targetProjectId: nullableStringSchema(),
  profileAspect,
  globalTitle: { type: ['string', 'null'], minLength: 1, maxLength: 512 },
  globalInstruction: { type: ['string', 'null'], minLength: 1, maxLength: 8192 },
  humanConfirmationReason: boundedString(4096),
  confirmedAt: dateTime,
  sessionId: id,
  idempotencyKey: id
};
const personalGlobalPreferenceDecisionRequired = [
  'personalSpaceId', 'candidateId', 'candidateVersion', 'decisionRevision',
  'decision', 'sourceItems', 'preferenceKey', 'targetScope',
  'targetProjectId', 'humanConfirmationReason',
  'confirmedAt', 'sessionId', 'idempotencyKey'
];
export const captureEpisodeFields = {
  idempotencyKey: id,
  name: label,
  sourceKind: boundedString(128),
  sourceDescription: boundedString(1024),
  sourceUri,
  sourceApplication,
  sourceTurnId: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
  sourceExcerpt: { type: ['string', 'null'], minLength: 1, maxLength: 2048 },
  referenceTime: dateTime,
  summary: longText,
  sensitivity: enumSchema(['normal', 'private', 'restricted']),
  entities: arraySchema(entity, { minItems: 1, maxItems: 128 }),
  relationships: arraySchema(relationship, { maxItems: 256 })
};
export const captureEpisodeRequired = [
  'idempotencyKey', 'name', 'sourceKind', 'sourceDescription',
  'referenceTime', 'entities', 'relationships'
];
const workflowObservedStep = objectSchema({
  actionId: id,
  name: label,
  summary: nullableStringSchema()
}, ['actionId', 'name']);

// Capturing, searching and governing personal and team-shared knowledge.
export const KNOWLEDGE_DEFINITIONS = [
  {
    name: 'capture_session_knowledge',
    description: 'Silently batch durable session knowledge when user-enabled capture policy permits. For online knowledge, sourceUri preserves the exact original HTTP(S) link for capable Agents to re-read and refresh Fuli knowledge; it grants no source-document writeback. Every item records discovery quadrant, structured confirmation basis, and pending/confirmed state. reasoningSummary is required for every entity/relationship whose originQuadrant is not known_known. Disabled policy returns capture_disabled without writes. Personal profile knowledge stays personal; only project knowledge with auditable confirmation may enter public review.',
    inputSchema: objectSchema({
      targetKind: {
        ...enumSchema(['personal', 'project']),
        description: 'Use "personal" for the personal graph, including knowledge scoped to a local personal project via personalProjectId. Use "project" only for a team-shared project queued for public review.'
      },
      spaceId: {
        ...id,
        description: 'With targetKind "personal", the active personal space id. With targetKind "project", the team-shared project id.'
      },
      personalProjectId: {
        ...nullableStringSchema(),
        description: 'Local personal project scope. Only meaningful with targetKind "personal".'
      },
      projectAgentId: {
        ...nullableStringSchema(),
        description: 'Optional project Agent owner for this knowledge. Requires targetKind "personal" and personalProjectId. Agent-scoped preferences and memory are excluded from every other Agent and from ordinary project-only retrieval.'
      },
      providerUrl: {
        ...nullableStringSchema(),
        description: 'Required with targetKind "project" and ignored for "personal".'
      },
      sessionId: id,
      ...captureEpisodeFields
    }, [
      'targetKind', 'spaceId', 'sessionId', ...captureEpisodeRequired
    ])
  },
  {
    name: 'record_workflow_transition_observation',
    title: 'WRITE · Observe one completed workflow transition',
    description: 'Record one Agent-reported completed X-to-Y action transition in the personal Provider, only after both actions succeed. One call submits one observation; same project, X/Y, workflow key, condition, and MCP-host session deduplicate to one Episodic node. Provider derives occurrence/distinct-session counts from persisted episodes. MCP host attests session, time, observation identity, never action truth. Accepts no aggregate counts, confirmation authority, approval, or durable-consent claims. All observations stay pending behavioral evidence, not user consent or execution authorization. This Agent/adapter observation seam is not automatic telemetry for arbitrary host tools.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      fromStep: workflowObservedStep,
      toStep: workflowObservedStep,
      workflowKey: id,
      condition: attributes,
      evidenceSummary: shortText,
      sourceApplication,
      sourceTurnId: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
      sensitivity: enumSchema(['normal', 'private', 'restricted'])
    }, [
      'personalSpaceId', 'fromStep', 'toStep', 'workflowKey', 'evidenceSummary'
    ])
  },
  {
    name: 'record_decision_trace',
    title: 'WRITE · Store a decision with its rationale',
    description: 'Store one bounded searchable project decision linking Decision, selected/rejected DecisionOption, DecisionRationale, and optional ValidationResult nodes. Require reason; never store bare conclusions. User/authoritative-source decisions are confirmed with audit basis; Agent-only proposals stay pending. Never copy raw transcripts, credentials, private contact details, or disposable deliberation.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      sessionId: id,
      idempotencyKey: id,
      decisionKey: id,
      title: label,
      question: shortText,
      selectedOption: objectSchema({
        key: id,
        label,
        summary: nullableStringSchema()
      }, ['key', 'label']),
      rejectedOptions: arraySchema(objectSchema({
        key: id,
        label,
        summary: nullableStringSchema()
      }, ['key', 'label']), { maxItems: 16 }),
      reason: boundedString(4096),
      validationResults: arraySchema(objectSchema({
        key: id,
        outcome: enumSchema(['pass', 'fail', 'inconclusive']),
        summary: shortText
      }, ['key', 'outcome', 'summary']), { maxItems: 16 }),
      decidedBy: decisionActor,
      referenceTime: dateTime,
      sourceKind: boundedString(128),
      sourceDescription: boundedString(1024),
      sourceUri,
      sourceApplication,
      sourceTurnId: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
      sensitivity: enumSchema(['normal', 'private', 'restricted'])
    }, [
      'personalSpaceId', 'sessionId', 'idempotencyKey', 'decisionKey',
      'title', 'question', 'selectedOption', 'reason', 'decidedBy',
      'referenceTime', 'sourceKind', 'sourceDescription'
    ])
  },
  {
    name: 'search_knowledge_graph',
    title: 'READ · Search the scoped knowledge graph',
    description: 'Search remembered URLs, routes, requirements, prior decisions, runbooks, architecture, rationale and preferences before saying you do not know. Scope: personal-global, exact active project, authorized PART_OF/USES_KNOWLEDGE_FROM parents, explicitly selected personal projects and subscribed team projects. RELATED_TO never expands scope: active human-authorized suggestions require confirmation for one read-only exact-project query. all_local_confirmed requires explicit user confirmation and never expands public projects. Pending stays marked; human-confirmed evidence outranks agent-confirmed evidence. Use source_uris to re-read originals before refreshing Fuli knowledge; cite sourceMarker only for supporting evidence, otherwise noMatchSourceMarker. Follow retrievalGuidance and its required next action for a miss: read-only local file search in current repository or workspace files within a safe root. Pages are bounded; repeat identical scope/query with next_cursor as cursor through fuli_call for full record fragments.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      query: shortText,
      personalProjectId: nullableStringSchema(),
      projectAgentId: nullableStringSchema(),
      contextPersonalProjectIds: arraySchema(id, { maxItems: 15 }),
      personalProjectScope: enumSchema(['bounded', 'all_local_confirmed']),
      projectIds: arraySchema(id, { maxItems: 32 }),
      cursor: boundedString(128),
      limit: integerSchema({ minimum: 1, maximum: 100 }),
      includeHistorical: booleanSchema(),
      includePending: booleanSchema()
    }, ['personalSpaceId', 'query'])
  },
  {
    name: 'search_connected_knowledge',
    title: 'READ · Search personal, public, and third-party knowledge',
    description: 'Search the exact personal project, explicitly selected subscribed public projects, and live read-only third-party bindings together. all_local_confirmed requires explicit user confirmation. Results stay separated by source with provenance; public-space integration is Beta. Returns project conflict policy: under ask_human, surface material conflicts in the Agent conversation and ask before choosing durable truth; under agent_decide, choose only for the current response and explain basis and sources. Never rewrites, confirms, invalidates, or publishes underlying knowledge.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      query: shortText,
      contextPersonalProjectIds: arraySchema(id, { maxItems: 15 }),
      personalProjectScope: enumSchema(['bounded', 'all_local_confirmed']),
      projectIds: arraySchema(id, { maxItems: 32 }),
      limit: integerSchema({ minimum: 1, maximum: 100 }),
      includeHistorical: booleanSchema(),
      includePending: booleanSchema()
    }, ['personalSpaceId', 'personalProjectId', 'query'])
  },
  KNOWLEDGE_USAGE_DEFINITION,
  ...KNOWLEDGE_TAG_DEFINITIONS,
  {
    name: 'record_knowledge_feedback',
    title: 'WRITE · Record negative knowledge evidence',
    description: 'Record bounded negative evidence for rejected, validation-failed, contradicted, or outdated retained knowledge. Require reason and evidence summary; idempotent per task, item, feedback kind, content generation. Lowers ranking signals and marks requires_attention. Never deletes evidence or silently overrides human-confirmed authority; trusted human/source contradiction may return agent-confirmed knowledge to pending. Pass the current taskContextToken.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      taskId: id,
      sessionId: nullableStringSchema(),
      taskContextToken: id,
      toolName: nullableStringSchema(),
      items: arraySchema(objectSchema({
        itemId: id,
        itemKind: knowledgeItemKind,
        feedbackKind: enumSchema([
          'rejected', 'validation_failed', 'contradicted', 'outdated'
        ]),
        reason: boundedString(2000),
        evidenceSummary: boundedString(4096),
        reportedByKind: enumSchema([
          'user', 'agent', 'authoritative_source'
        ]),
        sourceUri
      }, [
        'itemId', 'itemKind', 'feedbackKind', 'reason',
        'evidenceSummary', 'reportedByKind'
      ]), { minItems: 1, maxItems: 200 })
    }, ['personalSpaceId', 'taskId', 'items'])
  },
  {
    name: 'search_current_project_knowledge',
    title: 'READ · Search current project and its knowledge sources',
    description: 'For normal Agent work, pass projectPath and one or more focused queries. Resolves the exact local project, searches local knowledge first, then follows outgoing PART_OF/USES_KNOWLEDGE_FROM to authorized parent/source knowledge. Exact current-project items override inherited items with the same stable key. Never guesses ambiguous projects or traverses RELATED_TO. Returns structured related_project_suggestions to ask about adding exactly one related project to this read-only search; any expansion requires explicit human confirmation.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      personalProjectId: nullableStringSchema(),
      queries: arraySchema(shortText, { minItems: 1, maxItems: 10 }),
      cursor: boundedString(128),
      limitPerQuery: integerSchema({ minimum: 1, maximum: 50 }),
      includeHistorical: booleanSchema(),
      includePending: booleanSchema()
    }, ['projectPath', 'queries'])
  },
  {
    name: 'discover_common_knowledge_candidates',
    title: 'READ · Find possible parent-project knowledge',
    description: 'Read-only governance aid for one parent personal project. It searches each direct PART_OF child independently, excludes inherited and personal-global results, and groups lexically similar knowledge found in multiple children. Similarity is only an inferred candidate signal: the tool never merges, promotes, rewrites, or invalidates knowledge, and every candidate requires explicit human confirmation before a separate promotion action.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      parentProjectId: id,
      query: shortText,
      minChildProjects: integerSchema({ minimum: 2, maximum: 32 }),
      similarityThreshold: numberSchema({ minimum: 0, maximum: 1 }),
      limitPerProject: integerSchema({ minimum: 1, maximum: 50 })
    }, ['personalSpaceId', 'parentProjectId', 'query'])
  },
  {
    name: 'discover_personal_global_preference_candidates',
    title: 'READ · Find possible personal-global preferences',
    description: 'Read-only scope-governance aid across two or more explicitly selected personal projects. It searches each exact project independently, excludes inherited and existing personal-global results, preserves every original preference text, qualifier, project source, and source URI, and exposes any shared lexical core only as a non-authoritative derived candidate. Similarity and weight never apply or promote a preference. Every candidate requires explicit human scope judgment through the candidate-bound review workflow.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectIds: arraySchema(id, { minItems: 2, maxItems: 32 }),
      query: shortText,
      minProjects: integerSchema({ minimum: 2, maximum: 32 }),
      similarityThreshold: numberSchema({ minimum: 0, maximum: 1 }),
      limitPerProject: integerSchema({ minimum: 1, maximum: 50 })
    }, ['personalSpaceId', 'personalProjectIds', 'query'])
  },
  {
    name: 'preview_personal_global_preference_decision',
    title: 'READ · Inspect a version-bound scope decision',
    description: 'Read-only inspection for one exact personal-global preference candidate and decision revision. It revalidates every selected local source in the Provider and returns the preserved snapshots plus an exact payload fingerprint. It deliberately does not mint an approval token: an independent human-review client must confirm that fingerprint and mint the short-lived, one-time capability. The Agent cannot claim human authority through this tool.',
    inputSchema: objectSchema(
      personalGlobalPreferenceDecisionIntent,
      personalGlobalPreferenceDecisionRequired
    )
  },
  {
    name: 'preview_common_knowledge_promotion',
    title: 'CONFIRM · Preview parent-project promotion',
    description: 'Validate the exact common-knowledge promotion after a human has explicitly chosen the canonical item, duplicates, parent project, and rationale. The preview is read-only, requires items from distinct direct PART_OF children, and returns a short-lived token binding the exact intent. Do not treat inferred lexical similarity as human confirmation.',
    inputSchema: objectSchema(
      commonKnowledgePromotionIntent,
      commonKnowledgePromotionRequired
    )
  },
  {
    name: 'apply_common_knowledge_promotion',
    title: 'WRITE · Atomically promote parent knowledge',
    description: 'Apply one human-confirmed preview as a single Provider mutation. It moves the canonical item to the parent, enables descendants inheritance, invalidates selected child duplicates with replacement links, and stores both the scope reason and human-confirmation reason in permanent revision history. A valid one-time previewToken is mandatory.',
    inputSchema: objectSchema({
      ...commonKnowledgePromotionIntent,
      previewToken: id
    }, [...commonKnowledgePromotionRequired, 'previewToken'])
  },
  {
    name: 'get_knowledge_graph',
    description: 'Return a bounded node-edge graph for a personal space, one exact local personal project, or a team-shared project. An FLA sees its own knowledge only with projectAgentId and personalProjectId.',
    inputSchema: objectSchema({
      spaceId: id,
      providerUrl: nullableStringSchema(),
      personalProjectId: nullableStringSchema(), projectAgentId: nullableStringSchema(),
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
  }
];
