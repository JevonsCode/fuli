export function createLensController({
  elements,
  getJson,
  renderLensFacts,
  handleActionError,
  isActive = () => true
}) {
  let generation = 0;

  async function refreshLens() {
    const requestGeneration = ++generation;
    const personalSpaceId = elements.activePersonal.value;
    clearLens();
    if (!personalSpaceId || !isActive()) return;
    const params = new URLSearchParams({ personalSpaceId, budget: '1200' });
    try {
      const result = await getJson(`/api/lens?${params.toString()}`);
      if (!isCurrent(requestGeneration, personalSpaceId)) return;
      renderLensFacts(result.facts);
    } catch (error) {
      if (!isCurrent(requestGeneration, personalSpaceId)) return;
      clearLens();
      handleActionError(error);
    }
  }

  function isCurrent(requestGeneration, personalSpaceId) {
    return requestGeneration === generation &&
      elements.activePersonal.value === personalSpaceId &&
      isActive();
  }

  function clearLens() {
    elements.lensList.replaceChildren();
  }

  return { refreshLens };
}
