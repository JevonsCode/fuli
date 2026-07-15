import { elements } from './elements.js';
import { renderCandidates } from './render-candidates.js';
import { renderConnections } from './render-connections.js';
import { renderMemory } from './render-memory.js';
import { renderOverview } from './render-overview.js';
import { fillSelect } from './util.js';
import { syncViewVisibility } from './views.js';

export function createRenderer({ decideCandidate }) {
  return (state) => {
    const personalSpaces = state.spaces.filter((space) => space.kind === 'personal');
    const publicSpaces = state.spaces.filter((space) => space.kind === 'public');
    const pendingCandidates = state.candidates.filter((candidate) => candidate.status === 'pending');

    elements.candidateCount.textContent = pendingCandidates.length ? `${pendingCandidates.length}` : '';
    elements.pendingNavCount.textContent = pendingCandidates.length ? `${pendingCandidates.length}` : '';

    fillSelect(elements.activePersonal, personalSpaces);
    elements.activePersonal.hidden = personalSpaces.length <= 1;
    fillSelect(elements.subscriptionPersonal, personalSpaces);
    fillSelect(elements.subscriptionSpace, publicSpaces);

    renderOverview(state, pendingCandidates);
    renderMemory(state);
    renderCandidates(pendingCandidates, decideCandidate);
    renderConnections(state);
    syncViewVisibility();
  };
}
