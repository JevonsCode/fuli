import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { scrubbedMemoryGuidance } from '../agents/memory-state.js';
import { renderAgentMemoryExport } from '../agents/directory-snapshots.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';
import { captureDecision, captureDisabled } from './capture-decision.js';
import { coversClient } from '../agents/source-applications.js';

export function agentMemoryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !Number.isInteger(value.revision) || value.revision < 1 ||
    (value.memory_state != null && !['present', 'scrubbed'].includes(value.memory_state))) {
    throw invalidAgentMemoryResponse();
  }
  const scrubbed = value.memory_state === 'scrubbed';
  if (scrubbed ? value.memory !== null || typeof value.scrubbed_by !== 'string' || !value.scrubbed_by
    : !value.memory || typeof value.memory !== 'object' || Array.isArray(value.memory) || typeof value.memory.summary !== 'string') {
    throw invalidAgentMemoryResponse();
  }
  const metadata = {
    checkpointId: value.checkpoint_id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    agentId: value.agent_id,
    revision: value.revision,
    createdAt: value.created_at
  };
  if (scrubbed) return { ...metadata, memory: null, memoryState: 'scrubbed', scrubbedBy: value.scrubbed_by };
  return { ...metadata,
    memory: {
      summary: value.memory.summary,
      decisions: memoryNotes(value.memory.decisions),
      openThreads: memoryNotes(value.memory.open_threads),
      nextActions: memoryNotes(value.memory.next_actions)
    },
    sourceApplication: value.source_application,
    sourceSessionId: value.source_session_id ?? null,
    taskId: value.task_id ?? null
  };
}

export function agentMemoryView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !Number.isInteger(value.revision) || value.revision < 0 ||
    (value.history !== undefined && value.history !== null && !Array.isArray(value.history)) ||
    (value.work_log !== undefined && value.work_log !== null && (!Array.isArray(value.work_log)
      || value.work_log.some(log => !log || typeof log.summary !== 'string'
        || typeof log.task_context_token !== 'string' || typeof log.status !== 'string')))) {
    throw invalidAgentMemoryResponse();
  }
  const current = value.current === undefined || value.current === null
    ? null : agentMemoryRecord(value.current);
  const history = (value.history ?? []).map(agentMemoryRecord)
    .filter(record => record.revision !== current?.revision);
  return {
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    agentId: value.agent_id,
    scope: value.scope,
    storage: value.storage,
    authority: value.authority,
    revision: value.revision ?? 0,
    current,
    history,
    ...(current?.memoryState === 'scrubbed' ? { scrubbedGuidance: scrubbedMemoryGuidance(current.revision) } : {}),
    workLog: (value.work_log ?? []).map(log => ({
      taskContextToken: log.task_context_token, sourceApplication: log.source_application,
      sessionId: log.session_id, createdAt: log.created_at, status: log.status,
      summary: log.summary, memoryUpdated: log.memory_updated
    }))
  };
}

export async function getProjectAgentMemory(application, input) {
  const agent = await requireAgentMemoryAccess(application, input);
  return withMemorySnapshot(application, agent, input, await application.personal.getProjectAgentMemory(input));
}

// The owner console reads under its own authority, not an Agent's client
// allow-list; only durable Agents of the active space are projected.
export async function inspectProjectAgentMemory(application, input) {
  const value = await application.personal.getProjectAgentMemory(input);
  const view = agentMemoryView(value);
  if (!application.agentSnapshots) return view;
  let agent;
  try { agent = await application.getProjectAgent(input); } catch { return view; }
  return agent.memoryScope === 'reviewed_agent' ? withMemorySnapshot(application, agent, input, value) : view;
}

// The caller receives the view exactly as before. Only a Provider response that
// passes the task-entry scope check for exactly the requested space, project
// and Agent, including its current record and revision, is projected; otherwise
// only the authorized identity is refreshed.
function withMemorySnapshot(application, agent, input, value) {
  const view = agentMemoryView(value);
  let layers = [];
  try {
    layers = [scopedAgentMemoryView(value, { personalSpaceId: application.config.personal.spaceId,
      personalProjectId: input.personalProjectId ?? null, agentId: agent.agentId })];
  } catch { /* never written under the requested scope */ }
  const directorySnapshot = projectSnapshot(application, agent, layers);
  return directorySnapshot ? { ...view, directorySnapshot } : view;
}

// Project an authorized, scope-checked full read into the Agent's generated
// directory. The projection never fails or changes the database result.
export function projectSnapshot(application, agent, views) {
  const snapshots = application.agentSnapshots;
  if (!snapshots) return null;
  const personalSpaceId = application.config.personal.spaceId;
  const layers = views.filter(view => view && view.agentId === agent.agentId
    && view.personalSpaceId === personalSpaceId
    && view.scope === (view.personalProjectId === null ? 'private_agent_global' : 'private_agent_project'))
    .map(view => ({ personalProjectId: view.personalProjectId, revision: view.revision, current: view.current }));
  return snapshots.materialize({ personalSpaceId, agent, layers });
}

// A task checkpoint commits memory through the Provider without returning its
// content, so the snapshot is marked stale and regenerated on the next read.
export function withTaskMemorySnapshot(application, result) {
  const memory = result?.agent_memory;
  const directorySnapshot = memory?.status === 'checkpointed' ? application.agentSnapshots?.markStale({
    personalSpaceId: application.config.personal.spaceId, agentId: memory.agentId,
    personalProjectId: result.personal_project_id ?? null, revision: memory.revision
  }) : null;
  return directorySnapshot ? { ...result, agent_memory: { ...memory, directorySnapshot } } : result;
}

// Task entry injects memory without a human reading the request, so a view
// must declare exactly the requested space, project (null = global), Agent and
// scope. Records may omit inherited identity but must never name another one.
export function scopedAgentMemoryView(value, { personalSpaceId, personalProjectId, agentId }) {
  const view = agentMemoryView(value);
  const scope = personalProjectId === null ? 'private_agent_global' : 'private_agent_project';
  const foreign = record => record.agentId !== agentId
    || (record.personalProjectId !== undefined && record.personalProjectId !== personalProjectId)
    || (record.personalSpaceId !== undefined && record.personalSpaceId !== personalSpaceId)
    || record.revision > view.revision;
  // Every returned record is checked, including one repeating the current revision.
  const history = (value.history ?? []).map(agentMemoryRecord);
  if (view.personalSpaceId !== personalSpaceId || view.personalProjectId !== personalProjectId
    || view.agentId !== agentId || view.scope !== scope
    || (view.current ? foreign(view.current) || view.current.revision !== view.revision : view.revision !== 0)
    || history.some(foreign)) {
    throw invalidAgentMemoryResponse();
  }
  return view;
}

// A Markdown handoff of exactly one scope, rendered only from a fresh,
// authorized database read; generated files are never read back. The Agent
// tool applies the source client allow-list.
export async function exportProjectAgentMemory(application, input) {
  return memoryExport(application, await requireAgentMemoryAccess(application, input), input);
}

// The local owner console exports under its existing inspection authority.
export async function exportInspectedProjectAgentMemory(application, input) {
  const agent = await application.getProjectAgent(input);
  if (agent.memoryScope !== 'reviewed_agent') {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'A durable Agent is required for working memory');
  }
  return memoryExport(application, agent, input);
}

async function memoryExport(application, agent, input) {
  const personalProjectId = input.personalProjectId ?? null;
  const personalSpaceId = application.config.personal.spaceId;
  const value = await application.personal.getProjectAgentMemory({
    personalSpaceId: input.personalSpaceId, personalProjectId, agentId: input.agentId, limit: 1
  });
  // Rejects a malformed or foreign response before anything is rendered.
  const view = scopedAgentMemoryView(value, { personalSpaceId, personalProjectId, agentId: agent.agentId });
  const generatedAt = new Date().toISOString();
  const { filename, markdown } = renderAgentMemoryExport({
    agent, personalProjectId, revision: view.revision, current: view.current, generatedAt
  });
  // Refreshing the optional directory never affects the export.
  try { projectSnapshot(application, agent, [view]); } catch { /* optional projection */ }
  return { format: 'markdown', authority: 'database', generated: true, scope: view.scope,
    personalProjectId, revision: view.revision, recordedAt: view.current?.createdAt ?? null,
    generatedAt, filename, markdown };
}

export async function checkpointProjectAgentMemory(application, input) {
  const prepared = await prepareProjectAgentMemory(application, input);
  if (prepared.status === 'capture_disabled') return prepared;
  const value = await application.personal.writeProjectAgentMemory(prepared.request);
  const record = agentMemoryRecord(value);
  // After the committed write the record is the new current revision of exactly
  // the requested scope; a record naming any other scope is not projected.
  const personalProjectId = prepared.request.personal_project_id;
  const matches = record.agentId === prepared.agent.agentId
    && (record.personalProjectId === undefined || record.personalProjectId === personalProjectId)
    && (record.personalSpaceId === undefined || record.personalSpaceId === input.personalSpaceId);
  const directorySnapshot = matches ? projectSnapshot(application, prepared.agent, [{
    personalSpaceId: input.personalSpaceId, personalProjectId, agentId: record.agentId,
    revision: record.revision, current: record,
    scope: personalProjectId === null ? 'private_agent_global' : 'private_agent_project'
  }]) : null;
  return { status: 'checkpointed', ...record, ...(directorySnapshot ? { directorySnapshot } : {}) };
}

// Validate and normalize through the same boundary without performing a write.
// Task checkpoints send this payload to the Provider's atomic prepare operation.
export async function prepareProjectAgentMemory(application, input) {
  if (detectSensitiveContent(JSON.stringify(input.memory)).restricted) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'Agent working memory contains credentials');
  }
  const agent = await requireAgentMemoryAccess(application, input);
  const capture = await captureDecision(application, { sourceApplication: input.sourceApplication,
    personalProjectId: input.personalProjectId ?? null, sessionId: input.sourceSessionId ?? null });
  if (!capture.allowed) return captureDisabled(capture);
  return { agent, request: {
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId ?? null,
    agent_id: input.agentId,
    expected_revision: input.expectedRevision,
    idempotency_key: input.idempotencyKey,
    memory: {
      summary: input.memory.summary,
      decisions: input.memory.decisions ?? [],
      open_threads: input.memory.openThreads ?? [],
      next_actions: input.memory.nextActions ?? []
    },
    source_application: input.sourceApplication ?? 'other',
    source_session_id: input.sourceSessionId ?? null,
    task_id: input.taskId ?? null
  } };
}

async function requireAgentMemoryAccess(application, input) {
  const agent = await application.getProjectAgent(input);
  if (agent.profile.status !== 'active' || agent.memoryScope !== 'reviewed_agent') {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'An active durable Agent is required for working memory');
  }
  if (!coversClient(agent.profile.allowedClients, input.sourceApplication ?? 'other')) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'This client is not allowed to load the Agent memory');
  }
  return agent;
}

function memoryNotes(value) {
  const notes = value ?? [];
  if (!Array.isArray(notes) || notes.some(note => typeof note !== 'string')) {
    throw invalidAgentMemoryResponse();
  }
  return [...notes];
}

function invalidAgentMemoryResponse() {
  return new ApplicationError(
    ApplicationErrorCode.VALIDATION,
    'Provider returned an invalid Agent memory record'
  );
}
