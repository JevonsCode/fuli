// C7: a configured endpoint is no permission to send project content. The
// request's project and every evidence item must be approved for this role in
// the request's own personal space; content without a project needs its own
// approval. Checked before any request is built.
export function egressAllowed(request, egress) {
  const { personalSpaceId, personalProjectId } = request.scope;
  const approved = projectId => egress.approvedProjects.some(project =>
    project.personalSpaceId === personalSpaceId && project.personalProjectId === projectId);
  if (personalProjectId !== null && !approved(personalProjectId)) return false;
  return request.evidence.every(item => item.personalProjectId === null ? egress.allowUnassigned : approved(item.personalProjectId));
}
