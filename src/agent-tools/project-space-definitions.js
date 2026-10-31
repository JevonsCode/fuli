import { projectRelationDefinitions } from './project-relation-definitions.js';
import { dateTime, id, label, projectRelationType, shortText } from './graph-tool-fields.js';
import { arraySchema, boundedString, enumSchema, integerSchema, nullableStringSchema, objectSchema } from './schema.js';

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

// The knowledge spaces and local personal projects.
export const KNOWLEDGE_SPACE_DEFINITIONS = [
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
      profile: projectProfile,
      createOnly: { type: 'boolean', description: 'When true, fail with 409 instead of replacing an existing project with this projectId.' }
    }, ['personalSpaceId', 'projectId', 'profile'])
  },
  {
    name: 'list_personal_projects',
    description: 'List local personal project profiles and their coverage summaries, optionally for one exact projectId.',
    inputSchema: objectSchema({ personalSpaceId: id, projectId: boundedString(128) })
  }
];

// Publishing, subscribing to and reviewing team-shared projects.
export const PUBLIC_PROJECT_DEFINITIONS = [
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
  ...projectRelationDefinitions({ id, shortText, projectRelationType }),
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
