import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';

export function agentMemoryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !Number.isInteger(value.revision) || value.revision < 1 ||
    !value.memory || typeof value.memory !== 'object' || Array.isArray(value.memory) ||
    typeof value.memory.summary !== 'string') {
    throw invalidAgentMemoryResponse();
  }
  return {
    checkpointId: value.checkpoint_id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    agentId: value.agent_id,
    revision: value.revision,
    memory: {
      summary: value.memory.summary,
      decisions: memoryNotes(value.memory.decisions),
      openThreads: memoryNotes(value.memory.open_threads),
      nextActions: memoryNotes(value.memory.next_actions)
    },
    sourceApplication: value.source_application,
    sourceSessionId: value.source_session_id ?? null,
    taskId: value.task_id ?? null,
    createdAt: value.created_at
  };
}

export function agentMemoryView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !Number.isInteger(value.revision) || value.revision < 0 ||
    (value.history !== undefined && value.history !== null && !Array.isArray(value.history))) {
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
    history
  };
}

export async function getProjectAgentMemory(application, input) {
  await requireAgentMemoryAccess(application, input);
  return agentMemoryView(await application.personal.getProjectAgentMemory(input));
}

export async function checkpointProjectAgentMemory(application, input) {
  const prepared = await prepareProjectAgentMemory(application, input);
  if (prepared.status === 'capture_disabled') return prepared;
  const value = await application.personal.writeProjectAgentMemory(prepared.request);
  return { status: 'checkpointed', ...agentMemoryRecord(value) };
}

// Validate and normalize through the same boundary without performing a write.
// Task checkpoints send this payload to the Provider's atomic prepare operation.
export async function prepareProjectAgentMemory(application, input) {
  if (detectSensitiveContent(JSON.stringify(input.memory)).restricted) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'Agent working memory contains credentials');
  }
  await requireAgentMemoryAccess(application, input);
  const policy = application.getCapturePolicy?.() ?? { enabled: true };
  if (!policy.enabled) return { status: 'capture_disabled', capturePolicy: policy };
  return { request: {
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId,
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
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'An active durable Agent assignment is required for working memory');
  }
  if (!(agent.profile.allowedClients ?? []).includes(input.sourceApplication ?? 'other')) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'This client is not allowed to load the Agent memory');
  }
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
