import { scopeEgress } from '../model-backends/egress.js';
import { TONBORG_OPERATIONS } from './backend.js';

// rec#124: Tonborg's model may carry a project's knowledge out only when the
// person approved that project for it (C7, model-backends/egress.js). Its
// scheduled review skips a scope its model would refuse, instead of failing
// there every round, and the switch says which scopes it cannot reach. Both
// read the live settings, so approving a project takes effect on the next round.

// Whether Tonborg's model would refuse a knowledge review of this scope
// (personalProjectId null: knowledge outside projects). Without a model of its
// own, or with one on this computer, nothing is refused.
export function reviewEgressRefused(modelBackends, personalSpaceId, personalProjectId) {
  return modelBackends?.refusesEgress(scopeEgress({ role: 'tonborg', operation: TONBORG_OPERATIONS.review,
    scope: { personalSpaceId, personalProjectId } })) === true;
}

// What the switch says of the active projects: how many there are, which ones
// Tonborg's model may not read, and whether knowledge outside projects may go.
// A scope reviewed through the person's own CLI client sends nothing to the
// model, so the scheduled review still covers it (usesModel says which do not).
export function reviewReach(modelBackends, personalSpaceId, projectIds, usesModel = () => true) {
  const refused = projectId => usesModel(projectId) && reviewEgressRefused(modelBackends, personalSpaceId, projectId);
  return { projects: projectIds.length, blockedProjectIds: projectIds.filter(refused), unassignedAllowed: !refused(null) };
}
