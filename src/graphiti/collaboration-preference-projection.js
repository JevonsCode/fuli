export function agentCollaborationPreference(item) {
  const preference = {
    instruction: item.instruction ?? '',
    preference_key: item.preference_key ?? item.key ?? item.id,
    title: item.title ?? item.preference_key ?? item.key ?? item.id,
    profile_aspect: item.profile_aspect ?? null,
    preference_scope: item.preference_scope ?? 'global',
    confirmation_status: item.confirmation_status ?? 'confirmed'
  };
  if (item.preference_project_id) {
    preference.preference_project_id = item.preference_project_id;
  }
  for (const field of [
    'attributes',
    'weight',
    'reason',
    'confirmation_basis',
    'reasoning_summary',
    'inheritance_mode',
    'inherited_project_ids',
    'inherited_from_project_id',
    'scope_distance',
    'scope_path'
  ]) {
    if (item[field] !== undefined) preference[field] = item[field];
  }
  return preference;
}

export function deferredPreferenceConflicts(result, queuedConflicts) {
  const items = [
    ...(result.global_preferences ?? []),
    ...(result.project_preferences ?? [])
  ];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const activeConflictPairs = new Set(
    (result.conflicts ?? []).flatMap((conflict) => {
      const ids = conflict.item_ids ?? [];
      const pairs = [];
      for (let left = 0; left < ids.length; left += 1) {
        for (let right = left + 1; right < ids.length; right += 1) {
          pairs.push(preferenceConflictPairKey(ids[left], ids[right]));
        }
      }
      return pairs;
    })
  );
  const queued = (queuedConflicts ?? [])
    .filter((conflict) =>
      conflict.status === 'ai_pending' &&
      activeConflictPairs.has(preferenceConflictPairKey(
        conflict.left_item_id,
        conflict.right_item_id
      )) &&
      itemById.has(conflict.left_item_id) &&
      itemById.has(conflict.right_item_id)
    )
    .map((conflict) => ({
      ...conflict,
      left: itemById.get(conflict.left_item_id),
      right: itemById.get(conflict.right_item_id)
    }));
  const queuedPairs = new Set(queued.map((conflict) => preferenceConflictPairKey(
    conflict.left_item_id,
    conflict.right_item_id
  )));
  const inheritedScopeConflicts = (result.conflicts ?? []).flatMap((conflict) => {
    const alternatives = (conflict.item_ids ?? [])
      .map((id) => itemById.get(id))
      .filter(Boolean);
    const projectIds = [...new Set(alternatives
      .map(({ inherited_from_project_id: projectId }) => projectId)
      .filter(Boolean))]
      .sort();
    const pairAlreadyQueued = alternatives.length === 2 && queuedPairs.has(
      preferenceConflictPairKey(alternatives[0].id, alternatives[1].id)
    );
    if (
      pairAlreadyQueued ||
      alternatives.length < 2 ||
      projectIds.length < 2 ||
      alternatives.some(({ inherited_from_project_id: projectId }) => !projectId)
    ) {
      return [];
    }
    return [{
      id: `inherited-scope:${conflict.preference_key}:` +
        alternatives.map(({ id }) => id).sort().join(','),
      preference_key: conflict.preference_key,
      preference_scope: 'project',
      preference_project_ids: projectIds,
      status: 'human_scope_judgment_required',
      reason: 'Equally near parent projects define conflicting preferences for the active child.',
      inherited_scope_conflict: true,
      alternatives
    }];
  });
  return [...queued, ...inheritedScopeConflicts];
}

export function agentDeferredPreferenceConflict(conflict) {
  if (conflict.inherited_scope_conflict) {
    return {
      id: conflict.id,
      preference_key: conflict.preference_key,
      preference_scope: conflict.preference_scope,
      preference_project_ids: conflict.preference_project_ids,
      status: conflict.status,
      reason: conflict.reason,
      alternatives: conflict.alternatives.map(agentConflictPreference),
      automatic_resolution: false,
      requires_human_scope_judgment: true,
      required_action: 'Ask a human to choose or narrow the applicable project scope; do not use weight to select a winner.',
      resolution_options: []
    };
  }
  return {
    id: conflict.id,
    preference_key: conflict.preference_key,
    preference_scope: conflict.preference_scope,
    ...(conflict.preference_project_id
      ? { preference_project_id: conflict.preference_project_id }
      : {}),
    status: conflict.status,
    deferred_at: conflict.deferred_at,
    reason: conflict.reason,
    left: agentConflictPreference(conflict.left),
    right: agentConflictPreference(conflict.right),
    required_action: 'Resolve this conflict before using either side when it is relevant to the current task.',
    resolution_options: ['merge', 'keep_left', 'keep_right', 'split_scope']
  };
}

function agentConflictPreference(item) {
  const preference = {
    item_id: item.id,
    item_kind: item.item_kind,
    title: item.title,
    instruction: item.instruction,
    confirmed_at: item.confirmed_at,
    attributes: item.attributes ?? {}
  };
  for (const field of [
    'preference_project_id',
    'inherited_from_project_id',
    'scope_distance',
    'scope_path',
    'weight',
    'reason',
    'confirmation_basis',
    'reasoning_summary',
    'inheritance_mode',
    'inherited_project_ids'
  ]) {
    if (item[field] !== undefined) preference[field] = item[field];
  }
  return preference;
}

function preferenceConflictPairKey(leftId, rightId) {
  return [leftId, rightId].sort().join('\u0000');
}
