import { providerProjectProfile } from './project-profile-mapping.js';

export async function upsertPersonalProject(application, input) {
  if (input.personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Personal project must belong to the active personal space');
  }
  return application.personal.upsertPersonalProject({
    personal_space_id: input.personalSpaceId,
    project_id: input.projectId,
    profile: providerProjectProfile(input.profile),
    ...(input.createOnly === true ? { create_only: true } : {})
  });
}

export async function listPersonalProjects(application, input = {}) {
  const personalSpaceId = input.personalSpaceId ?? application.config.personal.spaceId;
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Personal projects must use the active personal space');
  }
  return application.personal.listPersonalProjects(personalSpaceId);
}

export async function listProjectRelationWeights(application, input = {}) {
  const personalSpaceId = input.personalSpaceId ?? application.config.personal.spaceId;
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Project relation weights must use the active personal space');
  }
  // The authenticated observation reader filters temporary/archived projects
  // and applies the same directional thresholds as the graph projection.
  const observations = await application.personal.readProjectMemoryUsage(personalSpaceId);
  return observations.map(row => ({ fromProjectId: row.source_project_id, toProjectId: row.target_project_id,
    tier: row.statistics.tier, recent30dCount: row.statistics.recent30dCount }));
}
