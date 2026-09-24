import { enumSchema, nullableStringSchema, objectSchema } from './schema.js';

export function projectRelationDefinitions({ id, shortText, projectRelationType }) {
  return [
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
  ];
}
