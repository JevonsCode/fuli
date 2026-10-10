export const TASK_ENTRY_TOOLS = new Set(['begin_task_context', 'get_collaboration_preferences']);

// Registers the exact repository ID the path resolver would match next time.
// A failed registration leaves the task unresolved rather than guessing.
export async function registerRepositoryProject(application, resolution) {
  const projectId = resolution.repositoryProjectId;
  try {
    await application.upsertPersonalProject({
      personalSpaceId: application.config.personal.spaceId,
      projectId,
      profile: { name: projectId, lifecycle: 'active' }
    });
  } catch {
    return resolution;
  }
  return { status: 'matched', basis: 'registered_repository', personalProjectId: projectId };
}
