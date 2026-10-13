import { compactKnowledgeItems, KNOWLEDGE_ITEM_DEFAULTS_NOTE } from '../graphiti/knowledge-item-view.js';

// Search tool results for Agents: compact knowledge items, and state once what
// every query of a multi-query search repeats. Result-level fields and source
// markers keep their structured shape because clients read them.
const SEARCH_TOOLS = new Set(['search_knowledge_graph', 'search_current_project_knowledge']);

export function compactKnowledgeToolResult(toolName, value) {
  if (!SEARCH_TOOLS.has(toolName) || !value || typeof value !== 'object') return value;
  if (toolName === 'search_knowledge_graph') return withItemNote(compactSearchResult(value));
  if (!Array.isArray(value.results)) return value;
  const first = value.results[0]?.retrievalGuidance;
  return withItemNote({ ...value, results: value.results.map((result, index) => {
    const compact = compactSearchResult(result);
    if (index > 0 && first && same(result?.retrievalGuidance, first)) {
      compact.retrievalGuidance = { same_as: 'results[0].retrievalGuidance' };
    }
    return compact;
  }) });
}

function compactSearchResult(result) {
  if (!result || typeof result !== 'object') return result;
  return { ...result,
    ...(Array.isArray(result.facts) ? { facts: compactKnowledgeItems(result.facts) } : {}),
    ...(Array.isArray(result.entities) ? { entities: compactKnowledgeItems(result.entities) } : {}) };
}

function withItemNote(view) {
  const results = Array.isArray(view.results) ? view.results : [view];
  const hasItems = results.some((result) => result?.facts?.length || result?.entities?.length);
  return hasItems ? { ...view, item_field_defaults: KNOWLEDGE_ITEM_DEFAULTS_NOTE } : view;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
