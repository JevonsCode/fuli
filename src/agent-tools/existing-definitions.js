import {
  booleanSchema,
  nullableStringSchema,
  objectSchema,
  stringSchema
} from './schema.js';

export const EXISTING_TOOL_DEFINITIONS = [
  {
    name: 'remember_episode',
    description: 'Capture a work episode and route it into personal, public, or candidate context.',
    inputSchema: objectSchema({
      personalSpaceId: stringSchema(),
      targetSpaceId: nullableStringSchema(),
      sourceKind: stringSchema(),
      body: stringSchema(),
      sourceUri: nullableStringSchema()
    })
  },
  {
    name: 'search_context',
    description: 'Search personal context and subscribed spaces without reading the whole store.',
    inputSchema: objectSchema({
      personalSpaceId: stringSchema(),
      query: stringSchema(),
      includeHistorical: booleanSchema()
    })
  },
  {
    name: 'get_current_facts',
    description: 'Return current facts for one space.',
    inputSchema: objectSchema({ spaceId: stringSchema() })
  },
  {
    name: 'get_timeline',
    description: 'Return the fact timeline for one subject in one space.',
    inputSchema: objectSchema({
      spaceId: stringSchema(),
      subject: stringSchema()
    })
  },
  {
    name: 'get_project_rules',
    description: 'Return current project parameters and forbidden methods with sources.',
    inputSchema: objectSchema({ spaceId: stringSchema() })
  },
  {
    name: 'get_fact_history',
    description: 'Return source-backed history for one predicate in one space.',
    inputSchema: objectSchema({
      spaceId: stringSchema(),
      predicate: stringSchema()
    })
  },
  {
    name: 'get_context_pack',
    description: 'Return a compact current context pack for one personal and project space.',
    inputSchema: objectSchema({
      personalSpaceId: stringSchema(),
      spaceId: stringSchema(),
      query: stringSchema()
    })
  },
  {
    name: 'observe_git_diff',
    description: 'Observe added lines in the current Git diff and route them through ingestion.',
    inputSchema: objectSchema({
      personalSpaceId: stringSchema(),
      targetSpaceId: nullableStringSchema(),
      cwd: nullableStringSchema()
    })
  },
  {
    name: 'list_candidates',
    description: 'List pending candidate observations for a personal space.',
    inputSchema: objectSchema({ personalSpaceId: stringSchema() })
  },
  {
    name: 'decide_candidate',
    description: 'Apply a human-triggered candidate decision: sync, personal_only, or ignore.',
    inputSchema: objectSchema({
      candidateId: stringSchema(),
      decision: stringSchema()
    })
  }
];
