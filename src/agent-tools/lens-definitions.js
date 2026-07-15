import {
  booleanSchema,
  enumSchema,
  integerSchema,
  numberSchema,
  objectSchema,
  stringSchema
} from './schema.js';
import { DEFAULT_SEARCH_USER_CONTEXT_LIMIT } from '../lens/lens-search-query.js';

const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 256;
const MAX_VALUE_LENGTH = 4096;
const MAX_EVIDENCE_LENGTH = 16384;
const MAX_QUERY_LENGTH = 2048;
const MAX_LENS_BUDGET = 16384;
const MAX_MCP_SEARCH_RESULTS = DEFAULT_SEARCH_USER_CONTEXT_LIMIT;

const PERSONAL_SPACE = { personalSpaceId: boundedString(MAX_ID_LENGTH) };
const WRITE_OPTIONS = {
  sourceKind: boundedString(MAX_LABEL_LENGTH),
  sensitivity: enumSchema(['normal', 'private', 'restricted']),
  confidence: numberSchema({ minimum: 0, maximum: 1 })
};

export const LENS_TOOL_DEFINITIONS = [
  {
    name: 'remember_user_fact',
    description: 'Remember an explicitly stated personal fact with its source.',
    inputSchema: objectSchema({
      ...PERSONAL_SPACE,
      subject: boundedString(MAX_LABEL_LENGTH),
      predicate: boundedString(MAX_LABEL_LENGTH),
      value: boundedString(MAX_VALUE_LENGTH),
      sourceText: boundedString(MAX_EVIDENCE_LENGTH),
      ...WRITE_OPTIONS
    }, ['predicate', 'value', 'sourceText'])
  },
  {
    name: 'submit_user_observation',
    description: 'Submit a direct or inferred personal observation with source evidence.',
    inputSchema: objectSchema({
      ...PERSONAL_SPACE,
      subject: boundedString(MAX_LABEL_LENGTH),
      predicate: boundedString(MAX_LABEL_LENGTH),
      value: boundedString(MAX_VALUE_LENGTH),
      evidenceText: boundedString(MAX_EVIDENCE_LENGTH),
      inference: enumSchema(['direct', 'inferred']),
      ...WRITE_OPTIONS
    }, ['predicate', 'value', 'evidenceText', 'inference'])
  },
  {
    name: 'correct_user_fact',
    description: 'Replace, reject, or deprecate a personal fact with correction evidence.',
    inputSchema: objectSchema({
      ...PERSONAL_SPACE,
      factId: boundedString(MAX_ID_LENGTH),
      action: enumSchema(['replace', 'reject', 'deprecate']),
      value: boundedString(MAX_VALUE_LENGTH),
      sourceText: boundedString(MAX_EVIDENCE_LENGTH),
      sourceKind: boundedString(MAX_LABEL_LENGTH)
    }, ['factId', 'action', 'sourceText'])
  },
  {
    name: 'confirm_observation',
    description: 'Confirm an observed or suggested personal fact with user evidence.',
    inputSchema: objectSchema({
      ...PERSONAL_SPACE,
      factId: boundedString(MAX_ID_LENGTH),
      sourceText: boundedString(MAX_EVIDENCE_LENGTH),
      sourceKind: boundedString(MAX_LABEL_LENGTH)
    }, ['factId', 'sourceText'])
  },
  {
    name: 'get_user_lens',
    description: 'Return a budgeted Personal Lens for the current task.',
    inputSchema: objectSchema({
      ...PERSONAL_SPACE,
      task: boundedString(MAX_QUERY_LENGTH),
      budget: integerSchema({ minimum: 1, maximum: MAX_LENS_BUDGET }),
      includeObserved: booleanSchema(),
      includeSuggested: booleanSchema(),
      includeRestricted: booleanSchema()
    }, ['task', 'budget'])
  },
  {
    name: 'search_user_context',
    description: 'Search source-backed personal facts and correction history.',
    inputSchema: objectSchema({
      ...PERSONAL_SPACE,
      query: boundedString(MAX_QUERY_LENGTH),
      limit: integerSchema({
        minimum: 1,
        maximum: MAX_MCP_SEARCH_RESULTS
      }),
      includeHistorical: booleanSchema(),
      includeRestricted: booleanSchema()
    }, ['query'])
  }
];

function boundedString(maxLength) {
  return { ...stringSchema(), maxLength };
}
