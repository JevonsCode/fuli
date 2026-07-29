export function personalContextProjectIds(activeProjectId, contextProjectIds = []) {
  const values = [activeProjectId, ...contextProjectIds]
    .filter((value) => typeof value === 'string' && value.length > 0);
  return [...new Set(values)];
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
