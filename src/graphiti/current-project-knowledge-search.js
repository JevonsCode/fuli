import { agentProjectResolution } from './agent-project-resolution.js';
import { budgetKnowledgeSearch } from './knowledge-result-budget.js';
import {
  relatedProjectGuidance,
  relatedProjectSuggestions
} from './related-project-suggestions.js';

// search_current_project_knowledge: the resolved project's own knowledge first,
// with related projects only suggested, never searched without confirmation.
export async function searchCurrentProjectKnowledge(
  application,
  resolution,
  {
    queries,
    limitPerQuery = 12,
    includeHistorical = false,
    includePending = false,
    cursor = null, sourceApplication = null
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
    related_project_suggestions: relatedProjects.suggestions,
    related_project_suggestions_status: relatedProjects.status,
    related_project_guidance: relatedProjectGuidance(relatedProjects.suggestions)
  }, { cursor, consoleUrl: application.consoleUrl, toolName: 'search_current_project_knowledge',
    context: { personalSpaceId: application.config.personal.spaceId,
      personalProjectId: resolution.personalProjectId, queries, limitPerQuery, includeHistorical, includePending } });
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
      suggestions: relatedProjectSuggestions(graph, personalProjectId)
    };
  } catch {
    return { status: 'unavailable', suggestions: [] };
  }
}
