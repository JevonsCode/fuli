import { configuredWorkspace } from './workspace-provider-client.js';

export async function createProjectRelation(application, input) {
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  return workspace.client.createProjectRelation(input.sourceProjectId, {
    target_project_id: input.targetProjectId,
    relation_type: input.relationType,
    note: input.note ?? null
  });
}

export async function listProjectRelations(application, input) {
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  return {
    projectId: input.projectId,
    providerUrl: workspace.providerUrl,
    relations: await workspace.client.listProjectRelations(input.projectId)
  };
}

export async function reviewProjectRelation(application, input) {
  const workspace = configuredWorkspace(application.workspaces, input.providerUrl);
  return workspace.client.decideProjectRelation(
    input.targetProjectId,
    input.relationId,
    { decision: input.decision, note: input.note ?? null }
  );
}
