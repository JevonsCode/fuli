import { repositoryProjectDraft } from './project-brief.js';
import { findRepositoryRoot } from './project-path-context.js';
import { originRemoteSource } from './repository-remote.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';

export const TASK_ENTRY_TOOLS = new Set(['begin_task_context', 'get_collaboration_preferences']);

// Registers the exact repository ID the path resolver would match next time.
// A failed registration leaves the task unresolved rather than guessing.
// Internal Agent activity never registers a project for itself.
export async function registerRepositoryProject(application, resolution, { sessionId = null, projectPath = null } = {}) {
  if (hostInternalActivity(application, { sessionId })) return { ...resolution, reason: 'internal_activity' };
  const projectId = resolution.repositoryProjectId;
  try {
    const draft = await repositoryProjectDraft({ projectPath });
    if (!draft) return resolution;
    const source = originRemoteSource(findRepositoryRoot(projectPath));
    await application.upsertPersonalProject({
      personalSpaceId: application.config.personal.spaceId,
      projectId,
      profile: { name: projectId, lifecycle: 'active', ...draft, ...(source ? { sources: [source] } : {}) }
    });
  } catch {
    return resolution;
  }
  return { status: 'matched', basis: 'registered_repository', personalProjectId: projectId };
}
