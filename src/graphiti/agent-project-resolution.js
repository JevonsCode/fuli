export function agentProjectResolution(resolution) {
  const result = {
    status: resolution.status,
    basis: resolution.basis,
    personal_project_id: resolution.personalProjectId
  };
  if (resolution.candidateCount !== undefined) {
    result.candidate_count = resolution.candidateCount;
  }
  return result;
}
