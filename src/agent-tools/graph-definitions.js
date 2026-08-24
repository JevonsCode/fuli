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
import {
  executorActualReportInput,
  executorAuthorizationStatus,
  executorHealthStatus,
  executorModel,
  executorProfile,
  executorRoutingRuleInput,
  nullableProjectAgentStatus,
  projectAgentAssignmentEndInput,
  projectAgentAssignmentInput,
  projectAgentAssignmentReplaceInput,
  projectAgentAssignmentStatus,
  projectAgentModelStrategy,
  projectAgentProfile,
  projectAgentTaskActivityInput,
  projectAgentTaskCoordinateInput,
  projectAgentTaskOutcomeInput,
  projectAgentTaskSubmitInput,
  recruitmentConfirmationMode,
  recruitmentDecision,
  recruitmentStatus,
  routingRuleScope
} from './project-agent-definitions.js';

const id = boundedString(256);
const label = boundedString(512);
const shortText = boundedString(2048);
const longText = boundedString(8192);
const idempotencyKey = { ...boundedString(256), minLength: 8 };
const dateTime = { ...boundedString(64), format: 'date-time' };
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
const epistemicQuadrant = enumSchema([
  'known_known', 'known_unknown', 'unknown_known', 'unknown_unknown'
]);
const epistemicStatus = enumSchema(['confirmed', 'observed', 'exploratory']);
// Agent-confirmed is a read state created only by the usage policy. Agent write
// tools may submit human/source-confirmed or pending knowledge, but cannot forge it.
const confirmationStatus = enumSchema(['confirmed', 'pending']);
const inheritanceMode = enumSchema([
  'local_only', 'descendants', 'selected_projects'
]);
const confirmationActor = objectSchema({
  kind: enumSchema(['user', 'agent', 'authoritative_source', 'import']),
  label: nullableStringSchema()
}, ['kind']);
const decisionActor = objectSchema({
  kind: enumSchema(['user', 'agent', 'authoritative_source']),
  label: nullableStringSchema()
}, ['kind']);
const confirmationBasis = objectSchema({
  existenceReason: boundedString(4096),
  quadrantReason: boundedString(4096),
  proposedBy: confirmationActor,
  confirmedBy: { ...confirmationActor, type: ['object', 'null'] },
  confirmedAt: nullableStringSchema(),
  agentPolicyVersion: nullableStringSchema()
}, ['existenceReason', 'quadrantReason', 'proposedBy']);
const knowledgeItemKind = enumSchema(['entity', 'relationship']);
const knowledgeReviewScope = enumSchema([
  'all', 'preferences_global', 'preferences_project', 'projects_all', 'project'
]);
const humanChangeStatus = enumSchema([
  'all', 'human_changed', 'unseen', 'viewed', 'reviewed'
]);
const projectRelationType = enumSchema([
  'PART_OF', 'USES_KNOWLEDGE_FROM', 'DEPENDS_ON', 'PROVIDES_TO', 'SHARES_CAPABILITY_WITH',
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
  reasoningSummary: {
    ...nullableStringSchema(),
    description: 'Required and nonempty whenever originQuadrant is not known_known. Explain how the item became known; omitting it rejects the whole batch.'
  },
  profileAspect,
  inheritanceMode,
  inheritedProjectIds: arraySchema(id, { maxItems: 32 })
};

const entity = objectSchema({
  key: id,
  name: label,
  type: { ...boundedString(64), pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
  summary: boundedString(4096),
  ...epistemicFields,
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


const personalProjectActionIntent = {
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
};
const personalProjectActionRequired = [
  'personalSpaceId', 'itemKind', 'itemId', 'mode', 'reason'
];
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
const captureEpisodeFields = {
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
const captureEpisodeRequired = [
  'idempotencyKey', 'name', 'sourceKind', 'sourceDescription',
  'referenceTime', 'entities', 'relationships'
];
const workflowObservedStep = objectSchema({
  actionId: id,
  name: label,
  summary: nullableStringSchema()
}, ['actionId', 'name']);

export const GRAPH_TOOL_DEFINITIONS = [
  {
    name: 'begin_task_context',
    title: 'LIFECYCLE · Begin a Fuli-aware task',
    description: 'Lifecycle entry used by supported Agent hooks before the model processes a user prompt. It resolves the exact local project from projectPath, loads effective collaboration preferences, and uses taskPrompt transiently for bounded automatic recall when the request signals a stable prior fact, runbook, URL, decision, release, deployment, or authentication method. It never stores or returns projectPath or taskPrompt. Inspect task_knowledge_recall before asking the user to repeat stable context. Returns an opaque taskContextToken. Claude Code setup installs this as a deterministic UserPromptSubmit hook; manual Agent calls are a fallback.',
    inputSchema: objectSchema({
      sessionId: id,
      projectPath: boundedString(4096),
      taskPrompt: boundedString(8192)
    }, ['sessionId', 'projectPath'])
  },
  {
    name: 'checkpoint_task_knowledge',
    title: 'LIFECYCLE · Finish knowledge review',
    description: 'Complete exactly one end-of-task knowledge review. Use capture_candidates only for a small durable batch supported by the task; captured Agent proposals remain pending unless the payload contains valid human or authoritative-source confirmation. Use retain_nothing when the turn produced no reusable knowledge. Never store raw transcripts, guesses, temporary logs, credentials, or disposable output.',
    inputSchema: objectSchema({
      taskContextToken: id,
      disposition: enumSchema(['capture_candidates', 'retain_nothing']),
      reason: boundedString(2000),
      capture: objectSchema(captureEpisodeFields, captureEpisodeRequired)
    }, ['taskContextToken', 'disposition', 'reason'])
  },
  {
    name: 'verify_task_checkpoint',
    title: 'LIFECYCLE · Verify end-of-task review',
    description: 'Hook-facing read that returns a Claude Code Stop decision. It blocks stopping only when begin_task_context succeeded for the session and checkpoint_task_knowledge has not yet recorded capture_candidates or retain_nothing.',
    inputSchema: objectSchema({ sessionId: id }, ['sessionId'])
  },
  {
    name: 'get_collaboration_preferences',
    title: 'READ FIRST · Load task collaboration preferences',
    description: 'Fallback for Agents or tasks without begin_task_context hook context. When no hook context was supplied, call this exact tool name at the start of every user task before any other tool or answer; never substitute a project action tool. Do not call it redundantly when the entry hook already supplied preferences. Pass projectPath as the current working directory and taskPrompt as the current user request. Fuli uses both transiently, never stores or returns them, resolves one exact registered local project, and performs bounded automatic recall only when the request signals stable prior context. Inspect task_knowledge_recall before asking the user to repeat a project fact or method. On a miss, search_current_project_knowledge with one to four focused action, artifact, target-system, or identifier queries; never use the full conversational request as the only query. Apply effective_preferences before answering or constructing tool arguments. Resolve only relevant deferred_conflicts first. For write tools, enforce preferences in the actual payload; the final answer is not compliance. Personal-global preferences always apply; conflicted, pending, invalid, ambiguous-project, and unrelated-project items never auto-apply. Automatic injection does not count as usage evidence. personalProjectId remains an explicit compatibility override.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      taskPrompt: boundedString(8192),
      personalProjectId: nullableStringSchema(),
      projectAgentId: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 200 })
    }, ['projectPath'])
  },
  {
    name: 'get_user_taste_skill',
    title: 'READ · Generate the current user-taste Skill',
    description: 'Generate a bounded, read-only user-taste Skill projection from the effective personal preferences for the exact active project. It uses prior confirmed and explicitly agent-confirmed preference data to provide task-specific recommendations, labels evidence status and scope, preserves the current-request and authoritative-constraint precedence, and never overwrites a user-authored taste Skill or promotes a pending inference. Call it when a UI, writing, product, architecture, code, or other judgment call would benefit from the user\'s established taste.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      taskPrompt: boundedString(8192),
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
    description: 'Silently batch durable session knowledge when the user-enabled capture policy allows it. When knowledge was read from an online source, sourceUri preserves the exact original HTTP(S) link so a capable Agent can re-read it later and refresh Fuli knowledge; it does not authorize source-document writeback. Every item records its discovery quadrant, structured confirmation basis, and pending or confirmed state. reasoningSummary is required for every entity or relationship whose originQuadrant is not known_known. A disabled policy returns capture_disabled without writing. Personal profile knowledge stays personal; only project knowledge with an auditable confirmation can enter public review.',
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
    description: 'Record one Agent-reported completed X-to-Y action transition in the personal Provider. One call submits one observation; calls for the same project, X/Y, workflow key, condition, and MCP-host session deduplicate to one Episodic node. The Provider derives occurrence and distinct-session counts from persisted episodes. The MCP host attests session, time, and observation identity, not the truth of the reported actions. The tool does not accept aggregate counts, confirmation authority, approval, or durable-consent claims. Every observation remains pending behavioral evidence and is not user consent or execution authorization. Call it only after both actions completed successfully. This is an Agent/adapter observation seam, not automatic telemetry for arbitrary host tools.',
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
    description: 'Store one bounded, searchable project decision as a linked Decision, selected and rejected DecisionOption nodes, a DecisionRationale, and optional ValidationResult nodes. reason is mandatory: do not store a bare conclusion. User or authoritative-source decisions are confirmed with their audit basis; Agent-only proposals remain pending. Do not copy raw transcripts, credentials, private contact details, or disposable deliberation.',
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
    description: 'Search durable context before saying you do not know when a task may depend on remembered URLs, routes, requirements, architecture, prior decisions, runbooks, rationale, or personal preferences. Supporting facts and entities expose bounded source_uris when their evidence came from online sources, allowing a capable Agent to re-read the original source before refreshing Fuli knowledge. Pending knowledge is searchable and explicitly marked; agent-confirmed knowledge ranks below human-confirmed knowledge. The bounded scope includes the personal-global profile, exact active local project, selectively inheritable knowledge reached through PART_OF or USES_KNOWLEDGE_FROM, explicitly selected additional personal projects, and selected subscribed team projects. Generic RELATED_TO links never expand scope. A result may instead include one-time read-only relatedProjectSuggestions only for active human-authorized RELATED_TO edges; ask the user before running the supplied exact-project follow-up query, and never silently add that project to future scope. Use all_local_confirmed only after explicit user confirmation; it searches registered local personal projects for this query and never expands public projects. If that still has no support, use read-only local file search in the current repository or workspace files within a safe root. The response includes sourceMarker for supporting results, noMatchSourceMarker when returned items do not support the answer, and retrievalGuidance with the required next action.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      query: shortText,
      personalProjectId: nullableStringSchema(),
      projectAgentId: nullableStringSchema(),
      contextPersonalProjectIds: arraySchema(id, { maxItems: 15 }),
      personalProjectScope: enumSchema(['bounded', 'all_local_confirmed']),
      projectIds: arraySchema(id, { maxItems: 32 }),
      limit: integerSchema({ minimum: 1, maximum: 100 }),
      includeHistorical: booleanSchema(),
      includePending: booleanSchema()
    }, ['personalSpaceId', 'query'])
  },
  {
    name: 'search_connected_knowledge',
    title: 'READ · Search personal, public, and third-party knowledge',
    description: 'Search the exact personal project, explicitly selected subscribed public projects, and live read-only third-party bindings in one request. Use all_local_confirmed only after explicit user confirmation. Results remain separated by source and preserve provenance; public-space integration is Beta. The response includes the project conflict policy. Under ask_human, surface a material conflict in the Agent conversation and ask the user before selecting durable truth. Under agent_decide, the Agent may choose for the current response only, but must explain its basis and sources. This tool never rewrites, confirms, invalidates, or publishes underlying knowledge.',
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
  {
    name: 'record_knowledge_usage',
    description: 'Record that personal knowledge materially affected the Agent final answer or completed action. Call only after the use actually occurs: cited means the answer explicitly relies on the item; applied means the item changed an implementation or decision. Retrieval, inspection, automatic preference injection, and merely appearing in context do not qualify. taskId must be the caller-stable identifier for the current user task and must be reused on retries; do not generate a fresh ID to recount the same task. Events are idempotent per knowledge item, task, use kind, and content generation. Repeated qualified use may promote pending knowledge to agent_confirmed, never to human-confirmed or public-eligible.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      taskId: id,
      sessionId: nullableStringSchema(),
      toolName: nullableStringSchema(),
      items: arraySchema(objectSchema({
        itemId: id,
        itemKind: knowledgeItemKind,
        useKind: enumSchema(['cited', 'applied'])
      }, ['itemId', 'itemKind', 'useKind']), { minItems: 1, maxItems: 200 })
    }, ['personalSpaceId', 'taskId', 'items'])
  },
  {
    name: 'record_knowledge_feedback',
    title: 'WRITE · Record negative knowledge evidence',
    description: 'Record bounded negative evidence when retained knowledge is rejected, fails validation, is contradicted, or becomes outdated. Each event requires a reason and evidence summary and is idempotent per task, item, feedback kind, and content generation. It lowers ranking signals and marks the item requires_attention. It never deletes evidence or silently overrides human-confirmed authority; trusted human/source contradiction can return agent-confirmed knowledge to pending.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      taskId: id,
      sessionId: nullableStringSchema(),
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
    description: 'High-level project search for normal Agent work. Pass projectPath plus one or more focused queries; Fuli resolves the exact local project, searches its local knowledge first, then follows outgoing PART_OF or USES_KNOWLEDGE_FROM relations to authorized parent/source knowledge. An exact current-project item with the same stable key overrides an inherited item. The tool never guesses an ambiguous project and never traverses RELATED_TO. Instead it returns structured related_project_suggestions so the Agent can ask whether to add exactly one related project to this read-only search; explicit human confirmation is required before any expansion.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      queries: arraySchema(shortText, { minItems: 1, maxItems: 10 }),
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
    name: 'upsert_project_agent',
    title: 'WRITE · Create or update a project Agent',
    description: 'Create or update one model-independent long-lived Agent bound to an existing local personal project. The profile is a lightweight project directory record: name, responsibility, capabilities, initial preferences, and status. This does not start a model or copy project knowledge into the Agent.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      agentId: boundedString(128),
      profile: projectAgentProfile
    }, ['personalSpaceId', 'agentId', 'profile'])
  },
  {
    name: 'list_project_agents',
    title: 'READ · Find project Agents by responsibility',
    description: 'Resolve the exact local project from projectPath and return its lightweight Agent directory. Optionally filter active/inactive/archived records or find Agents whose capabilities or responsibility match a capability query. This never loads another Agent\'s private memory.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      status: nullableProjectAgentStatus,
      capability: nullableStringSchema()
    }, ['projectPath'])
  },
  {
    name: 'get_project_agent_context',
    title: 'READ · Assemble one project Agent context',
    description: 'Resolve one active project Agent and assemble only the context needed for the task: personal-global rules, exact and authorized inherited project knowledge, this Agent\'s preferences and memory, and focused query results. It excludes every other project Agent. Fuli remains a control layer; the calling host Agent performs reasoning and execution.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      agentId: boundedString(128),
      queries: arraySchema(shortText, { minItems: 1, maxItems: 10 }),
      limitPerQuery: integerSchema({ minimum: 1, maximum: 50 }),
      includePending: booleanSchema()
    }, ['projectPath', 'agentId', 'queries'])
  },
  {
    name: 'get_project_agent',
    title: 'READ · Get one space-level Agent',
    description: 'Read one FULI space-level Agent identity, assignments, recruitment source, memory boundary, configured status, observed clients, and actual task state. Configured status is not a connection or online claim.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      agentId: id
    }, ['personalSpaceId', 'agentId'])
  },
  {
    name: 'delete_project_agent',
    title: 'WRITE · Archive one Agent identity',
    description: 'Archive one space-level Agent identity through the Provider after an explicit reason. Active assignments end, but task history, recruitment records, and routing audit remain preserved; the system coordinator cannot be archived.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      agentId: id,
      reason: shortText
    }, ['personalSpaceId', 'agentId', 'reason'])
  },
  {
    name: 'cleanup_test_project_agents',
    title: 'WRITE · Archive test Agent roles',
    description: 'Archive only test-marked Project Agents for one explicit test source through the Provider. Durable production identities are not touched; the result reports the number archived for cleanup verification.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      testSource: boundedString(256)
    }, ['personalSpaceId', 'testSource'])
  },
  {
    name: 'create_project_agent_assignment',
    title: 'WRITE · Assign an Agent to a project',
    description: 'Create one project-specific Agent assignment. The same space-level Agent may have many assignments; responsibility, capabilities, model override, and memory boundary stay project-scoped.',
    inputSchema: projectAgentAssignmentInput
  },
  {
    name: 'list_project_agent_assignments',
    title: 'READ · List Agent assignments',
    description: 'List project-Agent assignments and their full active/ended history. Never infer a runtime connection from assignment status.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      agentId: nullableStringSchema(),
      status: { ...projectAgentAssignmentStatus, type: ['string', 'null'] }
    }, ['personalSpaceId'])
  },
  {
    name: 'end_project_agent_assignment',
    title: 'WRITE · End an Agent assignment',
    description: 'End one project-Agent assignment with an expected revision. Stale revisions are rejected; the Agent and task history remain intact.',
    inputSchema: projectAgentAssignmentEndInput
  },
  {
    name: 'replace_project_agent_assignment',
    title: 'WRITE · Replace an Agent assignment',
    description: 'Atomically end one assignment and create its replacement, preserving replacement history and explicit reason.',
    inputSchema: projectAgentAssignmentReplaceInput
  },
  {
    name: 'coordinate_project_agent_task',
    title: 'WRITE · Prepare a host-executed Agent team',
    description: 'Resolve the exact local project, let the Provider coordinator route one durable task, and assemble an isolated context bundle for every selected lead/collaborator. The result is a truthful host execution plan: Fuli persists identity, staffing, and memory scope, while the calling host must start real workers, report their concrete worker/executor evidence, and finish their lifecycle. This tool never claims that a selected Agent is online or that a worker was started.',
    inputSchema: projectAgentTaskCoordinateInput
  },
  {
    name: 'acquire_runtime_lease',
    title: 'WRITE · Keep adaptive runtime awake',
    description: 'Acquire a host-held local adaptive-runtime lease before starting real project Agent workers. The MCP process heartbeats the lease until release; disabled adaptive mode returns a safe no-op handle. Use graph for Provider/database work and executor only for an executor managed by Fuli.',
    inputSchema: objectSchema({
      kind: enumSchema(['graph', 'executor']),
      executorId: nullableStringSchema(),
      owner: boundedString(256)
    }, ['kind', 'owner'])
  },
  {
    name: 'refresh_runtime_lease',
    title: 'WRITE · Refresh adaptive runtime lease',
    description: 'Explicitly refresh one lease owned by this MCP process. Automatic heartbeat normally makes this unnecessary; a missing or expired handle returns refreshed=false.',
    inputSchema: objectSchema({ leaseId: id }, ['leaseId'])
  },
  {
    name: 'release_runtime_lease',
    title: 'WRITE · Release adaptive runtime lease',
    description: 'Stop the heartbeat and release one host-held adaptive-runtime lease in a finally path. Repeated release is safe and returns released=false.',
    inputSchema: objectSchema({ leaseId: id }, ['leaseId'])
  },
  {
    name: 'submit_project_agent_task',
    title: 'WRITE · Submit a routed Agent task',
    description: 'Submit one durable task to the FULI control plane. Existing matching durable Agents are preferred; no anonymous temporary Agent is created. The Agent locked executor policy outranks task, assignment, project, and space rules; explicit user priority is never lowered for token savings. The space coordinator, complexity, model strategy, routing decision, boundaries, actual executor/model/rule/fallback audit fields, and any HR disclosure are persisted by the Provider.',
    inputSchema: projectAgentTaskSubmitInput
  },
  {
    name: 'view_project_agent_task',
    title: 'READ · View task, routing, and events',
    description: 'View one task with lead/collaborator assignments, routing decision, effective model strategy, source client/session, event history, actual executor/model, routing rule, and fallback audit. Missing connected state is not synthesized.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      taskId: id,
      includeEvents: booleanSchema()
    }, ['personalSpaceId', 'taskId'])
  },
  {
    name: 'record_project_agent_task_activity',
    title: 'WRITE · Record task activity',
    description: 'Record one explicit task event, including real terminal activity and actual executor/model/client attribution. Terminal activity is the only source for per-Agent activity summaries.',
    inputSchema: projectAgentTaskActivityInput
  },
  {
    name: 'view_project_agent_activity',
    title: 'READ · View Agent terminal activity',
    description: 'Return actual per-Agent daily completed/failed/cancelled activity and verifiable summaries. No history is fabricated and configured Agent status is not treated as running state.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      agentId: id,
      fromDate: nullableStringSchema(),
      toDate: nullableStringSchema()
    }, ['personalSpaceId', 'agentId'])
  },
  {
    name: 'get_project_agent_coordination_policy',
    title: 'READ · Get project Agent continuity policy',
    description: 'Read the exact project policy for asking before recruitment and automatically reusing the previous effective Agent. Both switches default on.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id
    }, ['personalSpaceId', 'personalProjectId'])
  },
  {
    name: 'update_project_agent_coordination_policy',
    title: 'WRITE · Set project Agent continuity policy',
    description: 'Persist the exact project switches for asking before recruitment and automatically reusing its previous effective Agent. This changes policy only and never starts a worker.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      askBeforeRecruitment: booleanSchema(),
      autoReusePreviousAgent: booleanSchema()
    }, [
      'personalSpaceId', 'personalProjectId',
      'askBeforeRecruitment', 'autoReusePreviousAgent'
    ])
  },
  {
    name: 'get_project_agent_recruitment_policy',
    title: 'READ · Get recruitment policy',
    description: 'Read the persisted recruitment confirmation mode. The default is automatic; require_confirmation creates only a pending recruitment event.',
    inputSchema: objectSchema({ personalSpaceId: id }, ['personalSpaceId'])
  },
  {
    name: 'update_project_agent_recruitment_policy',
    title: 'WRITE · Set recruitment policy',
    description: 'Persist automatic or require_confirmation recruitment authorization. This changes policy only; it does not create an Agent or recruitment record by itself.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      confirmationMode: recruitmentConfirmationMode
    }, ['personalSpaceId', 'confirmationMode'])
  },
  {
    name: 'list_project_agent_recruitments',
    title: 'READ · List recruitment records',
    description: 'List auditable HR recruitment records with trigger client/session, role, capabilities, position kind, reason, status, and created/recruited Agent.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      taskId: nullableStringSchema(),
      status: { ...recruitmentStatus, type: ['string', 'null'] }
    }, ['personalSpaceId'])
  },
  {
    name: 'decide_project_agent_recruitment',
    title: 'WRITE · Approve or cancel recruitment',
    description: 'Approve or cancel one pending HR recruitment event with an expected revision. Approval creates only the declared durable or bounded temporary role through the Provider.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      recruitmentId: id,
      expectedRevision: integerSchema({ minimum: 0 }),
      decision: recruitmentDecision,
      reason: shortText
    }, ['personalSpaceId', 'personalProjectId', 'recruitmentId', 'expectedRevision', 'decision', 'reason'])
  },
  {
    name: 'upsert_executor',
    title: 'WRITE · Register executor',
    description: 'Create or update one provider-neutral executor directory entry. Registration is configuration and authorization metadata; it does not claim the executor is connected or running.',
    inputSchema: executorProfile
  },
  {
    name: 'list_executors',
    title: 'READ · List executors',
    description: 'List executor directory entries with separate registration, permission, preflight, and health states. A connected field is returned only when the Provider has evidence; missing connected evidence stays absent.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      capability: nullableStringSchema(),
      availableOnly: booleanSchema()
    }, ['personalSpaceId'])
  },
  {
    name: 'get_executor',
    title: 'READ · Get executor',
    description: 'Inspect one executor directory entry and its preflight/audit fields without probing or fabricating a live connection.',
    inputSchema: objectSchema({ personalSpaceId: id, executorId: id }, ['personalSpaceId', 'executorId'])
  },
  {
    name: 'delete_executor',
    title: 'WRITE · Archive executor',
    description: 'Archive one executor directory entry through the Provider while retaining routing and outcome audit history.',
    inputSchema: objectSchema({ personalSpaceId: id, executorId: id }, ['personalSpaceId', 'executorId'])
  },
  {
    name: 'preflight_executor',
    title: 'WRITE · Report executor preflight',
    description: 'Record a real executor preflight report. The Provider verifies workspace permission and at least one advertised model before marking preflight passed; this tool never invokes work or fabricates availability.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      executorId: id,
      status: enumSchema(['passed', 'failed']),
      workspacePermission: booleanSchema(),
      capabilities: arraySchema(boundedString(512), { maxItems: 64 }),
      availableModels: arraySchema(executorModel, { maxItems: 64 }),
      reason: nullableStringSchema(),
      checkedAt: dateTime,
      idempotencyKey,
      sourceApplication,
      sourceSessionId: nullableStringSchema()
    }, ['personalSpaceId', 'executorId', 'status', 'workspacePermission', 'idempotencyKey', 'checkedAt'])
  },
  {
    name: 'authorize_executor',
    title: 'WRITE · Authorize executor workspace',
    description: 'Persist an explicit executor permission decision. Authorization is auditable metadata and does not claim the executor is connected or healthy.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      executorId: id,
      status: executorAuthorizationStatus,
      reason: shortText,
      expectedRevision: integerSchema({ minimum: 0 }),
      idempotencyKey
    }, ['personalSpaceId', 'executorId', 'status', 'reason', 'idempotencyKey'])
  },
  {
    name: 'report_executor_health',
    title: 'WRITE · Report executor health',
    description: 'Record a real executor health observation with its timestamp and source. This does not fabricate a connection or execute work.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      executorId: id,
      status: executorHealthStatus,
      reason: nullableStringSchema(),
      checkedAt: dateTime,
      idempotencyKey,
      sourceApplication,
      sourceSessionId: nullableStringSchema()
    }, ['personalSpaceId', 'executorId', 'status', 'checkedAt', 'idempotencyKey'])
  },
  {
    name: 'record_project_agent_executor_actual',
    title: 'WRITE · Report actual executor use',
    description: 'Record one real executor/model report after execution. The Provider rejects reports unless the executor is registered and the model was available in a passing preflight; Agent locked policy is checked before the report is accepted. Provider/model/client attribution is retained as audit evidence.',
    inputSchema: executorActualReportInput
  },
  {
    name: 'upsert_executor_routing_rule',
    title: 'WRITE · Configure executor routing rule',
    description: 'Create or update one explicit space, project, or task routing rule. Agent locked allow-lists outrank all other rules; user rules outrank coordinator rules; the default rule set is empty and no work-kind mapping is hardcoded.',
    inputSchema: executorRoutingRuleInput
  },
  {
    name: 'update_executor_routing_rule',
    title: 'WRITE · Update executor routing rule',
    description: 'Update one routing rule status with an expected revision. Existing task decisions and outcome evidence remain immutable.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      ruleId: id,
      expectedRevision: integerSchema({ minimum: 0 }),
      status: enumSchema(['active', 'disabled', 'ended']),
      reason: shortText,
      idempotencyKey
    }, ['personalSpaceId', 'ruleId', 'expectedRevision', 'status', 'reason', 'idempotencyKey'])
  },
  {
    name: 'list_executor_routing_rules',
    title: 'READ · List executor routing rules',
    description: 'List routing rules in explicit space → project → task scope order. Agent locked allow-lists outrank every scope; explicit user priority outranks coordinator defaults. The result includes source owner and actual fallback audit.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      scope: { ...routingRuleScope, type: ['string', 'null'] },
      personalProjectId: nullableStringSchema(),
      taskId: nullableStringSchema(),
      status: {
        type: ['string', 'null'],
        enum: ['active', 'disabled', 'ended', null]
      }
    }, ['personalSpaceId'])
  },
  {
    name: 'get_executor_routing_rule',
    title: 'READ · Get routing rule',
    description: 'Read one routing rule and its audit metadata without applying it locally.',
    inputSchema: objectSchema({ personalSpaceId: id, ruleId: id }, ['personalSpaceId', 'ruleId'])
  },
  {
    name: 'delete_executor_routing_rule',
    title: 'WRITE · Remove routing rule',
    description: 'Remove one explicit routing rule. Existing task decisions and outcome evidence remain immutable history.',
    inputSchema: objectSchema({ personalSpaceId: id, ruleId: id }, ['personalSpaceId', 'ruleId'])
  },
  {
    name: 'record_project_agent_task_outcome',
    title: 'WRITE · Record explicit routing outcome evidence',
    description: 'Record only explicit acceptance/satisfaction evidence such as rework_requested, repeated_negative_feedback, explicit_praise, test/acceptance pass or fail, or an explicit rating. Natural-language text is never used to infer satisfaction.',
    inputSchema: projectAgentTaskOutcomeInput
  },
  {
    name: 'list_project_agent_routing_learning',
    title: 'READ · View routing-learning evidence',
    description: 'List routing-learning evidence and flexible same-level tie-break weights with contribution, asOf, halfLife, and neutral/ignored status. Agent locked policy and explicit task/assignment/project/space priority always win; learning never overrides them or turns missing evidence into a preference.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      workKind: nullableStringSchema(),
      agentId: nullableStringSchema(),
      executorId: nullableStringSchema()
    }, ['personalSpaceId'])
  },
  {
    name: 'ignore_project_agent_routing_learning',
    title: 'WRITE · Ignore routing-learning evidence',
    description: 'Mark one routing-learning item ignored with an explicit reason; it remains auditable and cannot silently rewrite task history.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      agentId: id,
      evidenceId: id,
      idempotencyKey,
      reason: shortText
    }, ['personalSpaceId', 'personalProjectId', 'agentId', 'evidenceId', 'idempotencyKey', 'reason'])
  },
  {
    name: 'reset_project_agent_routing_learning',
    title: 'WRITE · Reset routing-learning weights',
    description: 'Reset selected routing-learning evidence or scope through the Provider. Reset records remain auditable and do not change historical routing decisions.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      workKind: boundedString(128),
      agentId: id,
      executorId: id,
      modelStrategy: projectAgentModelStrategy,
      modelStrategyKey: nullableStringSchema(),
      idempotencyKey,
      resetAt: dateTime,
      reason: shortText
    }, ['personalSpaceId', 'personalProjectId', 'workKind', 'agentId', 'executorId', 'idempotencyKey', 'resetAt', 'reason'])
  },
  {
    name: 'start_knowledge_review',
    title: 'REVIEW · Start or resume personal knowledge review',
    description: 'Start or resume the exact selected /flreview scope. A first review has no watermark and scans all in-scope history. A later review uses only the last completed run as its watermark; paused runs never advance it. Project scopes accept only local personal project IDs.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      scope: knowledgeReviewScope,
      personalProjectId: nullableStringSchema()
    }, ['personalSpaceId', 'scope'])
  },
  {
    name: 'list_knowledge_review_candidates',
    title: 'REVIEW · List ranked personal knowledge candidates',
    description: 'List one bounded page for an active or paused review. Provider policy ranks new/changed knowledge, conflicts or attention, low-weight knowledge, then repeated cross-session patterns. Already decided items stay out of the current run. The page limit is not a total-question cap.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      reviewId: id,
      limit: integerSchema({ minimum: 1, maximum: 50 })
    }, ['personalSpaceId', 'reviewId'])
  },
  {
    name: 'record_knowledge_review_progress',
    title: 'WRITE · Record one review outcome',
    description: 'Record one user-authorized candidate outcome after any required knowledge mutation succeeds. confirmed keeps the item, updated/invalidated follow successful writes, deferred carries it into the next review, and delegated_to_ai follows a successful current-quadrant change to unknown_unknown.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      reviewId: id,
      candidateKey: {
        ...boundedString(520),
        pattern: '^(entity|relationship):.+'
      },
      outcome: enumSchema([
        'confirmed', 'updated', 'invalidated', 'deferred', 'delegated_to_ai'
      ]),
      note: nullableStringSchema()
    }, ['personalSpaceId', 'reviewId', 'candidateKey', 'outcome'])
  },
  {
    name: 'finish_knowledge_review',
    title: 'WRITE · Pause or complete knowledge review',
    description: 'Pause a review without moving its watermark, or complete it and establish the next run watermark. Use completed only when the selected scope is exhausted or the user explicitly finishes it.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      reviewId: id,
      disposition: enumSchema(['paused', 'completed'])
    }, ['personalSpaceId', 'reviewId', 'disposition'])
  },
  {
    name: 'list_workflow_candidates',
    title: 'READ · List learned workflow candidates',
    description: 'Read persisted X-to-Y workflow candidates and their condition, explainable occurrence count, distinct-session count, recency, confirmation authority, negative evidence, declines, review status, and durable authorization. candidateVersion changes only when the rule definition changes; evidenceRevision tracks added or changed evidence; decisionRevision tracks review/authorization state transitions, including reset after a rule change. Rejected candidates and evidence remain in history. This read never executes a step or grants authority.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      afterStepKey: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 100 })
    }, ['personalSpaceId'])
  },
  {
    name: 'recommend_next_workflow_steps',
    title: 'READ · Recommend what to ask after a workflow step',
    description: 'Read persisted candidates matching the completed source step. Provider weights only decide whether a candidate crosses the recommendation threshold; they never grant execution authority. A recommended but unapproved candidate returns ask_user and must not execute Y. Even a durable authorization never replaces per-call approval for high-risk send, delete, publish, payment, or external-write tools.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      afterStepKey: id,
      limit: integerSchema({ minimum: 1, maximum: 100 })
    }, ['personalSpaceId', 'afterStepKey'])
  },
  {
    name: 'revise_personal_knowledge',
    description: 'Confirm, correct, invalidate, or restore one personal entity or relationship while preserving revision history and original evidence. This is the same personal-only operation used by the management UI.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      itemKind: knowledgeItemKind,
      itemId: id,
      action: enumSchema(['confirm', 'update', 'invalidate', 'restore']),
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
      profileAspect,
      inheritanceMode,
      inheritedProjectIds: arraySchema(id, { maxItems: 32 })
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
    name: 'preview_personal_project_action',
    title: 'PREVIEW · Authorize a personal project write',
    description: 'Required authorization step before apply_personal_project_action. Submit the complete intended write. For an existing project, it reports exact duplicates and confirmed same-name conflicts. A successful preview returns a short-lived, one-time previewToken bound to the exact action.',
    inputSchema: objectSchema(
      personalProjectActionIntent,
      personalProjectActionRequired
    )
  },
  {
    name: 'apply_personal_project_action',
    title: 'WRITE · Apply an authorized personal project action',
    description: 'WRITE operation. Never call during preference loading, project detection, knowledge retrieval, or any read-only task. Create a private personal project from one entity or add the entity to an existing personal project only after preview_personal_project_action. Requires the matching, short-lived, one-time previewToken and rejects changed or replayed actions. Existing ownership and evidence are preserved through references; duplicates are reused and conflicts follow the explicit resolution.',
    inputSchema: objectSchema({
      ...personalProjectActionIntent,
      previewToken: boundedString(256)
    }, [...personalProjectActionRequired, 'previewToken'])
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
