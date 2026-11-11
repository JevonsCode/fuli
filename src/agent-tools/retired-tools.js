import { ApplicationError } from '../app/application-error.js';

// Agent tools no client lists any more that an old client may still call.
// FULI promised that MCP tools are only added to, so for one release a retired
// name answers a clear refusal instead of "Unknown Fuli tool". The /flreview
// knowledge review was retired on 11-11 (Astro organises a project instead):
// remove these names, and this module, in the release after that one.
const KNOWLEDGE_REVIEW_TOOLS = new Set(['start_knowledge_review', 'list_knowledge_review_candidates',
  'record_knowledge_review_progress', 'finish_knowledge_review']);
const KNOWLEDGE_REVIEW_RETIRED = 'Knowledge review was retired; ask Astro to organise the project instead.';

// The refusal a retired tool name answers, or null for any other name.
export function retiredToolError(name) {
  return KNOWLEDGE_REVIEW_TOOLS.has(name) ? new ApplicationError('tool_retired', KNOWLEDGE_REVIEW_RETIRED) : null;
}
