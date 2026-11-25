import { ApplicationError } from '../app/application-error.js';
import { writeReservedProject } from '../runner/project-creation.js';
import { providerProjectProfile } from './project-profile-mapping.js';
import { applyProfileAuthorship, UNNAMED_AGENT_WRITER } from './project-profile-authors.js';
import { taskAgentIdentity } from './agent-conversations.js';
import { ProviderRequestError } from './provider-client.js';

const WRITER_KINDS = new Set(['person', 'agent']);

function remoteError(reply) {
  const reason = {
    owner_offline: 'The owner computer is offline. The change was not sent. 所属电脑离线，更改尚未送出。',
    owner_result_unknown: 'The request was sent. Its result is not yet confirmed. 请求已送出，结果尚未确认。',
    project_revision_required: 'Refresh the project before editing it. 请先刷新项目再编辑。',
    project_revision_changed: 'The owner has a newer revision. Refresh the project before editing. 所属电脑已有新版，请刷新后再编辑。',
    project_conflict: 'Two computers claim this project. Its changes are paused. 两台电脑都登记了此项目，已暂停修改。',
    ownership_unverified: 'Project ownership has not been verified. 项目归属待核实。'
  }[reply.code] ?? 'The owner could not complete this request. 所属电脑未能完成请求。';
  return new ApplicationError(reply.code, reason + (reply.operationId ? ' (' + reply.operationId + ')' : ''), { status: 409 });
}

// `writer` is set by the entry, never read from a caller's payload: the
// console route writes as the person, Agent tools as the task's FLA.
export async function upsertPersonalProject(application, input) {
  if (input.personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Personal project must belong to the active personal space');
  }
  if (!WRITER_KINDS.has(input.writer?.kind)) throw new TypeError('Personal project writer is required');
  const remote = await application.runnerHost?.projectCall?.({ project: input.projectId, action: 'project_update',
    relayed: input.relayed === true, operationId: input.operationId,
    input: { ...(input.createOnly ? {} : { expectedUpdatedAt: input.expectedUpdatedAt }),
      writer: input.writer, profile: input.profile } });
  if (remote) {
    if (!remote.ok) throw remoteError(remote);
    return { ...remote.value, source: remote.source, operationId: remote.operationId };
  }
  const createOnly = input.createOnly === true;
  const previous = createOnly ? null : await storedProfile(application, input.personalSpaceId, input.projectId);
  const write = async () => {
    const release = application.holdProjectWrite?.(input.personalSpaceId, [input.projectId]);
    try {
      // Re-read under admission: a move can finish between lookup and acquisition.
      const prior = !release || createOnly ? previous : await storedProfile(application, input.personalSpaceId, input.projectId);
      const { profile, refused } = applyProfileAuthorship(prior, providerProjectProfile(input.profile), input.writer);
      const saved = await application.personal.upsertPersonalProject({
        personal_space_id: input.personalSpaceId,
        project_id: input.projectId,
        profile,
        ...(input.expectedUpdatedAt ? { expected_updated_at: input.expectedUpdatedAt } : {}),
        ...(createOnly ? { create_only: true } : {})
      });
      application.projectChangeLog?.record({ personalSpaceId: input.personalSpaceId, projectId: input.projectId,
        writer: input.writer, previous: prior, saved });
      return refused.length ? { ...saved, refused_fields: refused } : saved;
    } finally { release?.(); }
  };
  return previous ? write() : writeReservedProject(application, input.projectId, write);
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
  const known = new Map(projects.map(project => [project.project_id, project]));
  for (const id of application.runnerHost?.reportedProjects?.() ?? []) {
    if (!known.has(id)) known.set(id, null);
  }
  const ids = input.projectId === undefined ? [...known.keys()] : [input.projectId].filter(id => known.has(id));
  return ids.flatMap(id => {
    const project = known.get(id);
    const source = application.runnerHost?.projectSource?.(id);
    if (source && (!project || !source.readable && !source.localClaim)) {
      return [{ project_id: id, personal_space_id: personalSpaceId, profile: { name: id }, source }];
    }
    return project ? [source ? { ...project, source } : project] : [];
  });
}

// The client and session that made each session temporary project, where FULI's own
// records prove it (graph-provider temporary_project_sources.py). A picker reads it
// when it shows temporary projects; the console state never does.
export function listTemporaryProjectSources(application, input = {}) {
  const personalSpaceId = input.personalSpaceId ?? application.config.personal.spaceId;
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Temporary project sources must use the active personal space');
  }
  return application.personal.listTemporaryProjectSources(personalSpaceId);
}

// What changed in one project's profile, newest first; local, so it needs no Provider.
export function listPersonalProjectHistory(application, input) {
  const personalSpaceId = input.personalSpaceId ?? application.config.personal.spaceId;
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Project history must use the active personal space');
  }
  const local = () => application.projectChangeLog.list({ personalSpaceId, projectId: input.projectId, limit: input.limit });
  const dispatch = application.runnerHost?.projectCall?.({ project: input.projectId, action: 'history_read',
    relayed: input.relayed === true, input: { limit: input.limit ?? 25 } });
  if (!dispatch) return local();
  return Promise.resolve(dispatch).then(remote => {
    if (!remote) return local();
    if (!remote.ok) throw remoteError(remote);
    return remote.value;
  });
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
