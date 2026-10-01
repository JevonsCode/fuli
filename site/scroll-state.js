/** Pure measurements shared by the scroll scenes and their navigation controls. */
export function clampProgress(value) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function sceneProgress(top, height, viewportHeight) {
  const travel = height - viewportHeight;
  // A static scene has no scroll interval to divide by.
  if (travel <= 0) return top < 0 ? 1 : 0;
  return clampProgress(-top / travel);
}

export function stageForProgress(progress, count = 4) {
  if (count <= 1) return 0;
  return Math.min(count - 1, Math.floor(clampProgress(progress) * count));
}

export function stageScrollTarget(
  top,
  height,
  viewportHeight,
  stage,
  count = 4,
) {
  const travel = Math.max(0, height - viewportHeight);
  if (count <= 1 || travel === 0) return Math.max(0, top);
  const boundedStage = Math.min(count - 1, Math.max(0, Math.trunc(stage)));
  // Land inside the stage's interval, away from rounding-sensitive boundaries.
  return Math.max(0, top + ((boundedStage + 0.5) / count) * travel);
}

export function pageProgress(scrollTop, documentHeight, viewportHeight) {
  const travel = documentHeight - viewportHeight;
  return travel > 0 ? clampProgress(scrollTop / travel) : 0;
}

export function resolveReducedMotion(systemReduced, userPreference) {
  return systemReduced || userPreference === true;
}
