import { providerProjectProfile } from './project-profile-mapping.js';
import { configuredWorkspace } from './workspace-provider-client.js';

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

export async function subscribePublicProject(application, input) {
  if (input.personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Subscription must belong to the active personal space');
  }
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  const accessible = await workspace.client.listSpaces();
  if (!accessible.some(({ id }) => id === input.projectId)) {
    throw new TypeError('Public project is not accessible with the configured identity');
  }
  return application.personal.subscribe({
    personal_space_id: input.personalSpaceId,
    project_id: input.projectId,
    provider_url: workspace.providerUrl,
    project_name: input.projectName
  });
}

export async function unsubscribePublicProject(application, input) {
  if (input.personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Subscription must belong to the active personal space');
  }
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  return application.personal.unsubscribe(
    input.personalSpaceId,
    input.projectId,
    workspace.providerUrl
  );
}

export async function publishPersonalProject(application, input) {
  if (input.personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Published project must belong to the active personal space');
  }
  const localProjectId = String(input.localProjectId ?? '').trim();
  if (!localProjectId) throw new TypeError('Local project ID is required');
  const releaseVersion = String(input.releaseVersion ?? '').trim();
  const updateSummary = String(input.updateSummary ?? '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(releaseVersion)) {
    throw new TypeError('Release version must use letters, numbers, dots, underscores, or hyphens');
  }
  if (!updateSummary || updateSummary.length > 4096) {
    throw new TypeError('Release update summary is required and must be at most 4096 characters');
  }
  const localProject = await application.personal.getPersonalProject(
    input.personalSpaceId,
    localProjectId
  );
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  const project = await workspace.client.createSpace({
    name: localProject.profile.name,
    kind: 'project',
    description: localProject.profile.purpose?.slice(0, 2000) ?? null,
    publication_key: localProject.publication_key,
    profile: providerProjectProfile(localProject.profile),
    release: {
      version: releaseVersion,
      summary: updateSummary
    }
  });
  const subscription = await application.personal.subscribe({
    personal_space_id: input.personalSpaceId,
    project_id: project.id,
    provider_url: workspace.providerUrl,
    project_name: project.name
  });
  return { project: { ...project, providerUrl: workspace.providerUrl }, subscription };
}

export async function listProjectReleases(application, input) {
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  return {
    projectId: input.projectId,
    providerUrl: workspace.providerUrl,
    releases: await workspace.client.listProjectReleases(input.projectId)
  };
}

export async function deletePublicProject(application, input) {
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  const result = await workspace.client.deleteProject(input.projectId);
  await application.personal.unsubscribe(
    application.config.personal.spaceId,
    input.projectId,
    workspace.providerUrl
  );
  return { ...result, providerUrl: workspace.providerUrl };
}

async function safely(operation, fallback) {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}
