import { ApplicationError } from '../app/application-error.js';

// One explicitly selected, authorized project. The ID comes from the person's
// instruction or the caller's current project, never from the template, so a
// spoofed source project cannot make FULI read or write another project.
export async function requireTeamTemplateProject(application, personalSpaceId, personalProjectId) {
  try {
    const project = await application.personal.getPersonalProject(personalSpaceId, personalProjectId);
    if (!project) throw notFound();
    return project;
  } catch (error) {
    if (error?.status === 404) throw notFound();
    throw error;
  }
}

function notFound() {
  return new ApplicationError('team_template_project_not_found',
    'No authorized project has this personalProjectId, so there is nothing to read or write.', { status: 404 });
}
