import { ApplicationError } from '../app/application-error.js';

// Agent tools no client lists any more that an old client may still call.
// FULI promised that MCP tools are only added to, so for one release a retired
// name answers a clear refusal instead of "Unknown Fuli tool". Everything here
// was retired on 11-11: remove these names, and this module, in the release
// after that one.
const KNOWLEDGE_REVIEW_RETIRED = 'Knowledge review was retired; ask Astro to organise the project instead.';
const RETIRED_TOOLS = new Map([
  // The /flreview knowledge review (Astro organises a project instead).
  ...['start_knowledge_review', 'list_knowledge_review_candidates', 'record_knowledge_review_progress',
    'finish_knowledge_review'].map((name) => [name, KNOWLEDGE_REVIEW_RETIRED]),
  // The personal-global preference decision, which could never be applied.
  ['preview_personal_global_preference_decision',
    'Personal-global preference decisions were removed; discover_personal_global_preference_candidates still lists candidates.']
]);

// The refusal a retired tool name answers, or null for any other name.
export function retiredToolError(name) {
  const message = RETIRED_TOOLS.get(name);
  return message ? new ApplicationError('tool_retired', message) : null;
}
