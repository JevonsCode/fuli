import { canonicalProviderUrl } from './runtime-config.js';
import {
  relatedProjectSuggestionsForSearchResults
} from './related-project-suggestions.js';

export function retrievalGuidanceForScope(personalProjectScope) {
  if (personalProjectScope === 'all_local_confirmed') {
    return {
      currentPersonalProjectScope: 'all_local_confirmed',
      markerToUseIfNoSupportingEvidence: 'noMatchSourceMarker',
      requiredNextActionIfNoSupportingEvidence:
        'search_current_workspace_files_or_ask_for_safe_root',
      workspaceFileSearch: {
        available: true,
        consentSource: 'bounded_expansion_confirmation',
        rootBoundary: 'current_working_directory',
        requiresSafeProjectOrWorkspaceRoot: true,
        forbiddenBroadRoots: ['user_home', 'filesystem_root'],
        readOnly: true,
        includesPublicProjects: false
      },
      instruction: 'Use read-only local file search in the current repository or explicit ' +
        'workspace root, preserving exact names first. If the working directory is the user ' +
        'home, filesystem root, or otherwise too broad, ask for a safe root. Never search ' +
        'outside that root or inspect credential stores; if no evidence supports the answer, ' +
        'ask for a source clue.'
    };
  }
  return {
    currentPersonalProjectScope: 'bounded',
    markerToUseIfNoSupportingEvidence: 'noMatchSourceMarker',
    requiredNextActionIfNoSupportingEvidence:
      'ask_user_to_confirm_all_local_and_workspace_search',
    expansion: {
      available: true,
      requiresExplicitUserConfirmation: true,
      input: { personalProjectScope: 'all_local_confirmed' },
      readOnly: true,
      oneQueryOnly: true,
      includesPublicProjects: false,
      includesCurrentWorkspaceFiles: true
    },
    instruction: 'Ask whether to widen this one read-only lookup to all registered local ' +
      'personal projects and, if still unresolved, current repository or workspace files. ' +
      'Exclude public projects and paths outside the current workspace; then stop and wait.'
  };
}

export async function loadSearchRelatedProjectSuggestions(application, result) {
  const hasExactProjectResult = [
    ...(result?.facts ?? []),
    ...(result?.entities ?? [])
  ].some((item) => (
    typeof item?.defined_project_id === 'string' &&
    item.defined_project_id &&
    !item.inherited_from_project_id &&
    Number(item.scope_distance ?? 0) === 0
  ));
  if (!hasExactProjectResult) {
    return { status: 'not_applicable', suggestions: [] };
  }
  try {
    const graph = await application.personal.graph(
      application.config.personal.spaceId,
      2000
    );
    return {
      status: graph?.truncated ? 'partial' : 'available',
      suggestions: relatedProjectSuggestionsForSearchResults(graph, result)
    };
  } catch {
    return { status: 'unavailable', suggestions: [] };
  }
}

export function groupSubscriptions(subscriptions) {
  const grouped = new Map();
  for (const subscription of subscriptions) {
    const url = canonicalProviderUrl(subscription.provider_url);
    if (!grouped.has(url)) grouped.set(url, []);
    grouped.get(url).push(subscription);
  }
  return grouped;
}

export function rankedSearchItems(searchResults, key, limit) {
  return searchResults
    .flatMap((result) => result[key])
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      searchItemScore(right.item) - searchItemScore(left.item) ||
      left.index - right.index
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

function searchItemScore(item) {
  return typeof item?.score === 'number' && Number.isFinite(item.score)
    ? item.score
    : 0;
}
