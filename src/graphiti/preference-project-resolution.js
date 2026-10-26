import { InvalidInputError } from '../app/application-error.js';

export async function resolvePreferenceProject(application, { personalProjectId, projectPath }) {
  if (projectPath !== undefined && projectPath !== null) {
    const projects = await application.personal.listPersonalProjects(
      application.config.personal.spaceId
    );
    const resolution = application.projectPathResolver(projectPath, projects);
    if (
      personalProjectId
      && resolution.personalProjectId
      && personalProjectId !== resolution.personalProjectId
    ) {
      throw new InvalidInputError(
        'personalProjectId conflicts with the exact projectPath match'
      );
    }
    if (personalProjectId) {
      return {
        status: 'matched',
        basis: 'explicit_personal_project_id',
        personalProjectId
      };
    }
    return resolution;
  }
  if (personalProjectId) {
    return {
      status: 'matched',
      basis: 'explicit_personal_project_id',
      personalProjectId
    };
  }
  return {
    status: 'not_provided',
    basis: null,
    personalProjectId: null
  };
}
