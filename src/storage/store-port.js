export const STORE_METHODS = Object.freeze([
  'transaction',
  'createSpace', 'listSpaces', 'findSpaceByName', 'getSpace',
  'subscribe', 'listSubscriptions', 'subscriptionsFor',
  'addEpisode', 'getEpisode', 'listEpisodes',
  'episodeEvidencePreview', 'correctionEpisodeEvidencePreviews',
  'addFact', 'getFact', 'updateFact', 'invalidateFact',
  'currentFacts', 'listFacts', 'timeline', 'searchFacts', 'searchFactsPage',
  'addCandidate', 'getCandidate', 'listCandidates',
  'pendingCandidates', 'updateCandidateStatus',
  'enqueueOutbox', 'listPendingOutbox', 'markOutboxSent', 'markOutboxFailed',
  'hasImport', 'recordImport',
  'exportSnapshot', 'importSnapshot', 'close'
]);

export function assertStorePort(store) {
  const missing = STORE_METHODS.filter((name) => typeof store?.[name] !== 'function');
  if (missing.length) throw new TypeError(`Store Port missing: ${missing.join(', ')}`);
  return store;
}
