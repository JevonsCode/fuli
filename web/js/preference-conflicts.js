export function detectPreferenceConflicts(items = []) {
  const candidates = items.filter((item) => item.profileAspect && !item.invalidAt);
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      const overlap = overlappingScope(left, right);
      if (!overlap || !samePreference(left, right) || sameMeaning(left, right)) continue;
      conflicts.push({
        id: [left.id, right.id].sort().join(':'),
        left,
        right,
        projectId: overlap.projectId,
        reason: conflictReason(left, right, overlap)
      });
    }
  }
  return conflicts;
}

export function conflictsForItem(conflicts, itemId) {
  return conflicts.filter(({ left, right }) => left.id === itemId || right.id === itemId);
}

function overlappingScope(left, right) {
  const leftScope = normalizedScope(left);
  const rightScope = normalizedScope(right);
  if (leftScope.scope === 'global' && rightScope.scope === 'global') {
    return { projectId: null, kind: 'global' };
  }
  if (leftScope.scope === 'project' && rightScope.scope === 'project') {
    return leftScope.projectId && leftScope.projectId === rightScope.projectId
      ? { projectId: leftScope.projectId, kind: 'project' }
      : null;
  }
  const project = leftScope.scope === 'project' ? leftScope : rightScope;
  return project.projectId ? { projectId: project.projectId, kind: 'global_project' } : null;
}

function normalizedScope(item) {
  return item.preferenceScope === 'project' && item.preferenceProjectId
    ? { scope: 'project', projectId: item.preferenceProjectId }
    : { scope: 'global', projectId: null };
}

function samePreference(left, right) {
  const leftKey = preferenceKey(left);
  const rightKey = preferenceKey(right);
  if (leftKey && rightKey) return leftKey === rightKey;
  return normalize(left.title) && normalize(left.title) === normalize(right.title);
}

function sameMeaning(left, right) {
  const leftValue = preferenceValue(left);
  const rightValue = preferenceValue(right);
  return leftValue === rightValue;
}

function conflictReason(left, right, overlap) {
  const explicitValues = Boolean(
    left.raw?.attributes?.preferenceValue && right.raw?.attributes?.preferenceValue
  );
  if (overlap.kind === 'global_project') {
    return explicitValues
      ? '全局偏好与项目偏好的取值不同；请确认项目项是否是有意例外。'
      : '全局偏好与项目偏好描述同一件事但内容不同；请确认是否为项目例外。';
  }
  return explicitValues
    ? '相同生效范围内，同一偏好的取值不同。'
    : '相同生效范围内，同名偏好的内容不同。';
}

function preferenceKey(item) {
  return normalize(item.raw?.attributes?.preferenceKey ?? item.raw?.attributes?.preference_key);
}

function preferenceValue(item) {
  return normalize(
    item.raw?.attributes?.preferenceValue ?? item.raw?.attributes?.preference_value ?? item.body
  );
}

function normalize(value) {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
