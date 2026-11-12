// The repository address and the folder name point to two projects (rec#125).
export const REMOTE_CONFLICT = 'repository_remote_conflict';

export function agentProjectResolution(resolution) {
  const result = {
    status: resolution.status,
    basis: resolution.basis,
    personal_project_id: resolution.personalProjectId
  };
  if (resolution.candidateCount !== undefined) {
    result.candidate_count = resolution.candidateCount;
  }
  // Only this conflict names its two candidates (IDs, never addresses).
  if (resolution.status === 'ambiguous' && resolution.reason === REMOTE_CONFLICT) {
    result.reason = REMOTE_CONFLICT;
    result.candidate_project_ids = resolution.candidateProjectIds ?? [];
  }
  return result;
}

// The required action for this conflict, or null for any other resolution.
export function remoteConflictAction(resolution) {
  if (resolution.status !== 'ambiguous' || resolution.reason !== REMOTE_CONFLICT) return null;
  // Callers hold either the resolver's object or its agentProjectResolution view.
  const [byRemote, byFolder] = resolution.candidateProjectIds ?? resolution.candidate_project_ids ?? [];
  return `The repository address points to project ${byRemote} and the folder name to project ${byFolder}. `
    + 'The person picks one (start the message with that project\'s name, or #FLA its Agent), or marks the '
    + 'repository source of the project it does not belong to as role "reference".';
}
