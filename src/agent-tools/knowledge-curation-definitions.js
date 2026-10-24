import {
  confirmationBasis,
  confirmationStatus,
  epistemicQuadrant,
  epistemicStatus,
  id,
  inheritanceMode,
  knowledgeItemKind,
  profileAspect,
  projectRelationType,
  shortText
} from './graph-tool-fields.js';
import { arraySchema, booleanSchema, boundedString, enumSchema, integerSchema, nullableStringSchema, objectSchema }
  from './schema.js';

const knowledgeReviewScope = enumSchema([
  'all', 'preferences_global', 'preferences_project', 'projects_all', 'project'
]);
const knowledgeConflictResolution = enumSchema([
  'defer', 'keep_target', 'use_source', 'coexist'
]);
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

// A person's curation of what FULI learned: review runs, learned workflow
// steps, revisions and the personal project an entity belongs to.
export const KNOWLEDGE_CURATION_DEFINITIONS = [
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
    description: 'Confirm, correct (a new version supersedes the old), mark_outdated (negative feedback that ends validity), invalidate, restore, or link a replacement for one personal entity or relationship; history and evidence are kept. A replacement link needs an invalidated item and an exact replacement ID and kind. Same personal-only operation as the management UI; Agent attribution is kept.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      itemKind: knowledgeItemKind,
      itemId: id,
      action: enumSchema(['confirm', 'update', 'mark_outdated', 'invalidate', 'restore', 'link_replacement']),
      replacementItemId: nullableStringSchema(),
      replacementItemKind: knowledgeItemKind,
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
  }
];
