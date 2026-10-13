import { compactKnowledgeItems, KNOWLEDGE_ITEM_DEFAULTS_NOTE } from '../graphiti/knowledge-item-view.js';

// Search tool results for Agents: compact items, and state once what every
// query of a multi-query search repeats. Source markers keep their structured
// contract because clients read their fields. Empty bookkeeping fields are omitted
// only at their documented empty value; a partial or failed search stays explicit.
const RESULT_DEFAULTS = {
  requestedProjectIds: (value) => Array.isArray(value) && !value.length,
  searchedProjectIds: (value) => Array.isArray(value) && !value.length,
  failedProjectIds: (value) => Array.isArray(value) && !value.length,
  subscriptions: (value) => Array.isArray(value) && !value.length,
  relatedProjectSuggestions: (value) => Array.isArray(value) && !value.length,
  relatedProjectGuidance: (value) => value === null,
  projectAgentId: (value) => value === null,
  partial: (value) => value === false
};
const SEARCH_TOOLS = new Set(['search_knowledge_graph', 'search_current_project_knowledge']);

export function compactKnowledgeToolResult(toolName, value) {
  if (!SEARCH_TOOLS.has(toolName) || !value || typeof value !== 'object') return value;
  if (toolName === 'search_knowledge_graph') return withItemNote(compactSearchResult(value));
  if (!Array.isArray(value.results)) return value;
  const first = value.results[0]?.retrievalGuidance;
  const view = { ...value, results: value.results.map((result, index) => {
    const compact = compactSearchResult(result);
    if (index > 0 && first && same(result.retrievalGuidance, first)) {
      compact.retrievalGuidance = 'same as results[0].retrievalGuidance';
    }
    return compact;
  }) };
  if (Array.isArray(view.related_project_suggestions) && !view.related_project_suggestions.length) {
    delete view.related_project_suggestions;
  }
  if (view.related_project_guidance === null) delete view.related_project_guidance;
  return withItemNote(view);
}

function compactSearchResult(result) {
  if (!result || typeof result !== 'object') return result;
  const view = {};
  for (const [key, item] of Object.entries(result)) {
    if (RESULT_DEFAULTS[key]?.(item)) continue;
    view[key] = key === 'facts' || key === 'entities' ? compactKnowledgeItems(item) : item;
  }
  return view;
}

function withItemNote(view) {
  const results = Array.isArray(view.results) ? view.results : [view];
  const hasItems = results.some((result) => result?.facts?.length || result?.entities?.length);
  return hasItems ? { ...view, item_field_defaults: KNOWLEDGE_ITEM_DEFAULTS_NOTE } : view;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
