export function applyCapabilityVisibility(root, state) {
  const capabilities = state?.capabilities ?? {};
  for (const node of root.querySelectorAll('[data-capability]')) {
    node.hidden = capabilities[node.dataset.capability] !== true;
  }
  const reviewAvailable = hasReviewWorkspace(state);
  for (const node of root.querySelectorAll('[data-review-navigation], [data-review-metric]')) {
    node.hidden = !reviewAvailable;
  }
}

export function hasReviewWorkspace(state) {
  const capabilities = state?.capabilities ?? {};
  return capabilities.submitKnowledge === true || capabilities.reviewProposals === true;
}
