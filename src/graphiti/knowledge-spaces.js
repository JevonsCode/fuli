// The active personal space, its projects, and what the configured workspace
// providers and existing subscriptions still show (read only).
export async function listKnowledgeSpaces(application) {
  const [availablePersonalSpaces, personalProjects, subscriptions, ...workspaceSpaces] = await Promise.all([
    application.personal.listSpaces(),
    application.personal.listPersonalProjects(application.config.personal.spaceId),
    application.personal.listSubscriptions(application.config.personal.spaceId),
    ...[...application.workspaces.values()].map(async (workspace) => ({
      providerUrl: workspace.providerUrl,
      principalId: workspace.principalId,
      spaces: await safely(() => workspace.client.listSpaces(), [])
    }))
  ]);
  const personalSpaces = availablePersonalSpaces.filter(({ id }) => id === application.config.personal.spaceId);
  return {
    activePersonalSpaceId: application.config.personal.spaceId,
    personalSpaces,
    personalProjects,
    projects: workspaceSpaces.flatMap(({ providerUrl, principalId, spaces }) =>
      spaces.map((space) => ({
        ...space,
        providerUrl,
        isOwner: space.owner_id === principalId
      }))
    ),
    subscriptions
  };
}

async function safely(operation, fallback) {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}
