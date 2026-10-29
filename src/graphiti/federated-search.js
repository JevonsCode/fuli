import { personalContextProjectIds, personalProjectSearchBatches, scopedSearchItems } from './personal-context.js';
import { createFuliSourceMarker } from './source-marker.js';
import { relatedProjectGuidance } from './related-project-suggestions.js';
import { groupSubscriptions, loadSearchRelatedProjectSuggestions, rankedSearchItems,
  retrievalGuidanceForScope } from './federated-search-support.js';
import { recordReadExtensionUsage } from './project-memory-usage.js';
import { budgetKnowledgeSearch } from './knowledge-result-budget.js';

export async function searchFederatedKnowledge(application, {
  personalSpaceId,
  query,
  projectIds = [],
  personalProjectId = null,
  projectAgentId = null,
  contextPersonalProjectIds = [],
  personalProjectScope = 'bounded',
  limit = 12,
  includeHistorical = false,
  includePending = true,
  agentInvocation = false,
  agentToolName = 'search_knowledge_graph',
  sourceApplication = null,
  sourceSessionId = null,
  cursor = null,
  view = 'full',
  ids = null
}, { workspaceFor, recordAgentViews }) {
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Search must use the active personal space');
  }
  if (!['bounded', 'all_local_confirmed'].includes(personalProjectScope)) {
    throw new TypeError('Unknown personal project search scope');
  }
  if (projectAgentId && (!personalProjectId || personalProjectScope !== 'bounded')) {
    throw new TypeError(
      'Project Agent search requires one bounded active personal project'
    );
  }
  const subscriptions = projectIds.length
    ? await application.personal.listSubscriptions(personalSpaceId)
    : [];
  const requestedProjects = new Set(projectIds);
  const selectedSubscriptions = subscriptions.filter(({ project_id: projectId }) =>
    requestedProjects.has(projectId)
  );
  if (selectedSubscriptions.length !== requestedProjects.size) {
    throw new TypeError('Every selected project must be an active subscription');
  }
  const selectedPersonalProjectIds = personalProjectScope === 'all_local_confirmed'
    ? personalContextProjectIds(
      null,
      (await application.personal.listPersonalProjects(personalSpaceId))
        .map(({ project_id: projectId }) => projectId)
    )
    : personalContextProjectIds(personalProjectId, contextPersonalProjectIds);
  const personalSearches = personalProjectSearchBatches(selectedPersonalProjectIds)
    .map((personalProjectIds, index) => {
      const activePersonalProjectId = (
        personalProjectScope === 'bounded' &&
        personalProjectId &&
        personalProjectIds.includes(personalProjectId)
      ) ? personalProjectId : null;
      return application.personal.search({
      space_ids: [personalSpaceId],
      query,
      limit,
      include_historical: includeHistorical,
      include_exploratory: includePending,
      personal_project_ids: personalProjectIds,
      active_personal_project_id: activePersonalProjectId,
      project_agent_id: activePersonalProjectId ? projectAgentId : null,
      inherit_project_knowledge: personalProjectScope === 'bounded',
      include_personal_global: index === 0
      });
    });
  const grouped = groupSubscriptions(selectedSubscriptions);
  const workspaceSearches = [...grouped.entries()].map(([providerUrl, items]) => {
    const projectIdsForProvider = items.map(({ project_id: projectId }) => projectId);
    return {
      projectIds: projectIdsForProvider,
      operation: (async () => {
        const workspace = workspaceFor(providerUrl);
        const result = await workspace.client.search({
          space_ids: projectIdsForProvider,
          query,
          limit,
          include_historical: includeHistorical,
          include_exploratory: includePending
        });
        return scopedSearchItems(result, 'project', workspace.providerUrl);
      })()
    };
  });
  const searchResults = await Promise.allSettled([
    ...personalSearches,
    ...workspaceSearches.map(({ operation }) => operation)
  ]);
  const personalSettlements = searchResults.slice(0, personalSearches.length);
  const personalFailure = personalSettlements.find(({ status }) => status === 'rejected');
  if (personalFailure) throw personalFailure.reason;
  const personalItems = personalSettlements
    .map(({ value }) => scopedSearchItems(
      value,
      'personal',
      null,
      application.config.personal.spaceId
    ));
  const successfulProjectIds = new Set();
  const failedProjectIds = new Set();
  const projects = [];
  searchResults.slice(personalSearches.length).forEach((settlement, index) => {
    const { projectIds: providerProjectIds } = workspaceSearches[index];
    if (settlement.status === 'fulfilled') {
      projects.push(settlement.value);
      providerProjectIds.forEach((projectId) => successfulProjectIds.add(projectId));
      return;
    }
    providerProjectIds.forEach((projectId) => failedProjectIds.add(projectId));
  });
  const requestedProjectIds = [...requestedProjects];
  const searchedProjectIds = requestedProjectIds.filter((projectId) =>
    successfulProjectIds.has(projectId)
  );
  const unavailableProjectIds = requestedProjectIds.filter((projectId) =>
    failedProjectIds.has(projectId)
  );
  const rankedSources = [...personalItems, ...projects];
  const facts = rankedSearchItems(rankedSources, 'facts', limit);
  const entities = rankedSearchItems(rankedSources, 'entities', limit);
  const sourceMarker = createFuliSourceMarker({
    consoleUrl: application.consoleUrl,
    facts,
    entities
  });
  const noMatchSourceMarker = createFuliSourceMarker({
    consoleUrl: application.consoleUrl,
    facts: [],
    entities: []
  });
  if (agentInvocation) {
    await recordAgentViews([
      ...facts
        .filter(({ scope }) => scope === 'personal')
        .map(({ id }) => ({ item_id: id, item_kind: 'relationship' })),
      ...entities
        .filter(({ scope }) => scope === 'personal')
        .map(({ id }) => ({ item_id: id, item_kind: 'entity' }))
    ], agentToolName);
  }
  const relatedProjects = await loadSearchRelatedProjectSuggestions(
    application,
    { facts, entities }
  );
  if (agentInvocation) await recordReadExtensionUsage(application, { sourceApplication, sourceSessionId,
    personalProjectScope, contextPersonalProjectIds, facts, entities }).catch(() => {});
  const result = {
    query,
    sourceMarker,
    noMatchSourceMarker,
    retrievalGuidance: retrievalGuidanceForScope(personalProjectScope),
    facts: agentInvocation ? facts.map(agentSearchItem) : facts,
    entities: agentInvocation ? entities.map(agentSearchItem) : entities,
    personalGlobalIncluded: true,
    personalProjectScope,
    projectAgentId,
    searchedPersonalProjectIds: selectedPersonalProjectIds,
    requestedProjectIds,
    searchedProjectIds,
    failedProjectIds: unavailableProjectIds,
    partial: unavailableProjectIds.length > 0,
    subscriptions: selectedSubscriptions,
    relatedProjectSuggestions: relatedProjects.suggestions,
    relatedProjectSuggestionsStatus: relatedProjects.status,
    relatedProjectGuidance: relatedProjectGuidance(relatedProjects.suggestions)
  };
  return agentInvocation && agentToolName === 'search_knowledge_graph'
    ? budgetKnowledgeSearch(result, { cursor, view, ids, consoleUrl: application.consoleUrl,
      context: { personalSpaceId, query, personalProjectId, projectAgentId, contextPersonalProjectIds,
        personalProjectScope, projectIds, limit, includeHistorical, includePending } }) : result;
}

// Console percentages are presentation metadata, not another Agent weight.
function agentSearchItem(item) {
  const view = { ...item };
  delete view.weight_percent;
  delete view.confirmed_by_person;
  return view;
}
