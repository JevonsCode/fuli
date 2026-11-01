import { providerProjectProfile } from './project-profile-mapping.js';
import { applyProfileAuthorship, UNNAMED_AGENT_WRITER } from './project-profile-authors.js';
import { taskAgentIdentity } from './agent-conversations.js';
import { ProviderRequestError } from './provider-client.js';

const WRITER_KINDS = new Set(['person', 'agent']);

// `writer` is set by the entry, never read from a caller's payload: the
// console route writes as the person, Agent tools as the task's FLA.
export async function upsertPersonalProject(application, input) {
  if (input.personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Personal project must belong to the active personal space');
  }
  if (!WRITER_KINDS.has(input.writer?.kind)) throw new TypeError('Personal project writer is required');
  const createOnly = input.createOnly === true;
  const previous = createOnly ? null : await storedProfile(application, input.personalSpaceId, input.projectId);
  const { profile, refused } = applyProfileAuthorship(previous, providerProjectProfile(input.profile), input.writer);
  const saved = await application.personal.upsertPersonalProject({
    personal_space_id: input.personalSpaceId,
    project_id: input.projectId,
    profile,
    ...(createOnly ? { create_only: true } : {})
  });
  return refused.length ? { ...saved, refused_fields: refused } : saved;
}

// The FLA of the calling Agent's task; an unknown or missing task still writes
// as an Agent, only without a name.
export async function agentProfileWriter(application, { taskContextToken, sourceApplication }) {
  if (!taskContextToken) return UNNAMED_AGENT_WRITER;
  try {
    const task = await application.taskContextRegistry.context(taskContextToken, sourceApplication);
    const { name } = await taskAgentIdentity(application, task);
    return { kind: 'agent', ...(task.projectAgentId ? { agentId: task.projectAgentId } : {}), ...(name ? { agentName: name } : {}) };
  } catch {
    return UNNAMED_AGENT_WRITER;
  }
}

export async function listPersonalProjects(application, input = {}) {
  const personalSpaceId = input.personalSpaceId ?? application.config.personal.spaceId;
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Personal projects must use the active personal space');
  }
  const projects = await application.personal.listPersonalProjects(personalSpaceId);
  return input.projectId === undefined ? projects : projects.filter(project => project.project_id === input.projectId);
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

async function storedProfile(application, personalSpaceId, projectId) {
  try {
    return (await application.personal.getPersonalProject(personalSpaceId, projectId)).profile;
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) return null;
    throw error;
  }
}
