// C7: a configured endpoint is no permission to send project content. The
// request's project and every evidence item must be approved for this role in
// the request's own personal space; content without a project needs its own
// approval. Checked before any request is built.
export function egressAllowed(request, egress) {
  const { personalSpaceId, personalProjectId } = request.scope;
  const approved = projectId => projectApproved(egress, personalSpaceId, projectId);
  if (personalProjectId !== null && !approved(personalProjectId)) return false;
  return request.evidence.every(item => item.personalProjectId === null ? egress.allowUnassigned : approved(item.personalProjectId));
}

// The egress question of a role's operation in one scope, before any evidence
// exists: everything it would send belongs to that scope's project (or to none).
export function scopeEgress({ role, operation, scope }) {
  const personalProjectId = scope.personalProjectId ?? null;
  return { role, operation, scope: { personalSpaceId: scope.personalSpaceId, personalProjectId },
    evidence: [{ personalProjectId }] };
}

// A role choosing what it may send asks the same question first.
export function projectApproved(egress, personalSpaceId, personalProjectId) {
  return egress.approvedProjects.some(project =>
    project.personalSpaceId === personalSpaceId && project.personalProjectId === personalProjectId);
}
