import { agentProjectResolution } from './agent-project-resolution.js';
import { budgetKnowledgeSearch } from './knowledge-result-budget.js';
import {
  relatedProjectGuidance,
  relatedProjectSuggestions
} from './related-project-suggestions.js';

// search_current_project_knowledge: the resolved project's own knowledge first,
// with related projects only suggested, never searched without confirmation.
// Search matches words; the Agent asking understands meaning. When no query
// matched, it gets the project's titles to judge for itself: FULI needs no model
// of its own for that, and the titles cost tokens only on a miss.
const INDEX_TITLES = 40;
const INDEX_TITLE_CHARS = 120;
// What the entry already delivers, or what is no knowledge to read.
const NOT_INDEXED = new Set(['PersonalProject', 'ProjectSource', 'PersonalPreference']);
const INDEX_READ = 'Nothing matched these words. If a title here means what you need, search for its exact words before relying on it; pending items are not confirmed.';
export async function searchCurrentProjectKnowledge(
  application,
  resolution,
  {
    queries,
    limitPerQuery = 12,
    includeHistorical = false,
    includePending = false,
    cursor = null, sourceApplication = null,
    view = 'full', ids = null
  }
) {
  const projectResolution = agentProjectResolution(resolution);
  if (!resolution.personalProjectId) {
    return {
      status: 'project_unresolved',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: null,
      project_resolution: projectResolution,
      results: [],
      required_action: resolution.status === 'ambiguous'
        ? 'Run from the exact project directory or explicitly choose one project; Fuli will not guess among workspace children.'
        : 'Register this repository or directory as one local personal project before project-scoped search.'
    };
  }

  const [results, relatedProjects] = await Promise.all([
    Promise.all(queries.map((query) =>
      application.searchKnowledge({
        personalSpaceId: application.config.personal.spaceId,
        personalProjectId: resolution.personalProjectId,
        query,
        limit: limitPerQuery,
        includeHistorical,
        includePending, sourceApplication,
        agentInvocation: true,
        agentToolName: 'search_current_project_knowledge'
      })
    )),
    loadRelatedProjectSuggestions(application, resolution.personalProjectId)
  ]);
  const index = !cursor && results.every(noMatch) ? projectTitleIndex(relatedProjects.graph) : null;
  return budgetKnowledgeSearch({
    status: 'searched',
    personal_space_id: application.config.personal.spaceId,
    personal_project_id: resolution.personalProjectId,
    project_resolution: projectResolution,
    scope_policy: {
      local_project_first: true,
      inherited_relation_types: ['PART_OF', 'USES_KNOWLEDGE_FROM'],
      max_inheritance_hops: 2,
      local_same_key_overrides_parent: true,
      unrelated_relations_expand_scope: false,
      related_project_expansion_requires_confirmation: true
    },
    results,
    ...(index ? { knowledge_index: index } : {}),
    related_project_suggestions: relatedProjects.suggestions,
    related_project_suggestions_status: relatedProjects.status,
    related_project_guidance: relatedProjectGuidance(relatedProjects.suggestions)
  }, { cursor, view, ids, consoleUrl: application.consoleUrl, toolName: 'search_current_project_knowledge',
    context: { personalSpaceId: application.config.personal.spaceId,
      personalProjectId: resolution.personalProjectId, queries, limitPerQuery, includeHistorical, includePending } });
}

const noMatch = result => !result?.facts?.length && !result?.entities?.length;

// Confirmed first, newest within each; a bounded list, with how many there are.
function projectTitleIndex(graph) {
  const items = (graph?.nodes ?? []).filter(node => !NOT_INDEXED.has(node.type) && !node.invalid_at && node.name);
  if (!items.length) return null;
  const confirmed = node => (node.confirmation_status === 'confirmed' ? 0 : 1);
  const ordered = items.sort((left, right) => confirmed(left) - confirmed(right) || String(right.created_at).localeCompare(String(left.created_at)));
  return { total: items.length, read: INDEX_READ, titles: ordered.slice(0, INDEX_TITLES)
    .map(node => [String(node.name).slice(0, INDEX_TITLE_CHARS), node.confirmation_status === 'confirmed' ? 'confirmed' : 'pending']) };
}

async function loadRelatedProjectSuggestions(application, personalProjectId) {
  try {
    const graph = await application.personal.graph(
      application.config.personal.spaceId,
      2000,
      personalProjectId
    );
    return {
      status: graph?.truncated ? 'partial' : 'available',
      suggestions: relatedProjectSuggestions(graph, personalProjectId),
      graph
    };
  } catch {
    return { status: 'unavailable', suggestions: [] };
  }
}
