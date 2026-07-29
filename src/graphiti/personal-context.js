const PERSONAL_PROJECT_SEARCH_BATCH_SIZE = 16;

export function personalContextProjectIds(activeProjectId, contextProjectIds = []) {
  const values = [activeProjectId, ...contextProjectIds]
    .filter((value) => typeof value === 'string' && value.length > 0);
  return [...new Set(values)];
}

export function personalProjectSearchBatches(projectIds) {
  if (projectIds.length === 0) return [[]];
  const batches = [];
  for (let index = 0; index < projectIds.length; index += PERSONAL_PROJECT_SEARCH_BATCH_SIZE) {
    batches.push(projectIds.slice(index, index + PERSONAL_PROJECT_SEARCH_BATCH_SIZE));
  }
  return batches;
}

export function scopedSearchItems(result, scope, providerUrl = null, defaultSpaceId = null) {
  const project = (item) => ({
    ...item,
    scope,
    providerUrl,
    spaceId: item.space_id ?? defaultSpaceId
  });
  return {
    facts: (result.facts ?? []).map(project),
    entities: (result.entities ?? []).map(project)
  };
}
