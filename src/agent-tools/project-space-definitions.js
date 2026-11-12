import { dateTime, id, label, shortText } from './graph-tool-fields.js';
import { arraySchema, boundedString, enumSchema, integerSchema, nullableStringSchema, objectSchema } from './schema.js';

const projectSource = objectSchema({
  key: boundedString(128),
  kind: enumSchema([
    'prd', 'product_document', 'technical_document', 'frontend_repository',
    'backend_repository', 'repository', 'design', 'runbook', 'monitoring',
    'issue_tracker', 'other'
  ]),
  // Default own; only own repositories identify a checkout (rec#125).
  role: enumSchema(['own', 'reference']),
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
    description: 'Create or update a local personal project profile, including evidence sources and an explainable display-only summary of evidence already present. Do not generate missing-item claims. You may fill empty or Agent-written purpose, scope, technicalSummary and boundaries; a field a person wrote is kept and listed in refused_fields.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      projectId: boundedString(128),
      profile: projectProfile,
      createOnly: { type: 'boolean', description: 'When true, fail with 409 instead of replacing an existing project with this projectId.' },
      taskContextToken: { ...id, maxLength: 160, description: 'Current task token; records your FLA as the author of the fields you write.' }
    }, ['personalSpaceId', 'projectId', 'profile'])
  },
  {
    name: 'list_personal_projects',
    description: 'List local personal project profiles and their coverage summaries, optionally for one exact projectId.',
    inputSchema: objectSchema({ personalSpaceId: id, projectId: boundedString(128) })
  }
];

// The health of the personal and configured workspace providers.
export const PROVIDER_STATUS_DEFINITIONS = [
  {
    name: 'get_graphiti_status',
    description: 'Return health and storage mode for the personal and configured workspace providers.',
    inputSchema: objectSchema({})
  }
];
