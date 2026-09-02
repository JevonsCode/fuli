import { randomUUID } from 'node:crypto';

import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';

const MAX_ACTIVE_SESSIONS = 256;

function unknownTokenError() {
  return new ApplicationError(
    ApplicationErrorCode.NOT_FOUND,
    'Fuli task context token is unknown or superseded. Call begin_task_context for the current session and use the token it returns.'
  );
}

export class TaskContextRegistry {
  constructor({ tokenFactory = () => `fuli-task-${randomUUID()}` } = {}) {
    this.tokenFactory = tokenFactory;
    this.sessions = new Map();
    this.tokens = new Map();
  }

  begin({ sessionId, turnId = null, personalProjectId, projectAgentId = null,
    sourceApplication = 'other', sourceSessionId = null, memoryRevision = null }) {
    assertNonEmpty(sessionId, 'sessionId');
    const key = sessionKey(sourceApplication, sessionId);
    const previous = this.sessions.get(key) ?? null;
    if (!previous) this.#reserveSessionSlot();
    if (previous) this.tokens.delete(previous.token);

    const task = {
      token: this.tokenFactory(),
      sessionId,
      turnId,
      personalProjectId: personalProjectId ?? null,
      projectAgentId,
      sourceApplication,
      sourceSessionId,
      memoryRevision,
      agentMemory: null,
      checkpoint: null
    };
    this.sessions.delete(key);
    this.sessions.set(key, task);
    this.tokens.set(task.token, task);
    return {
      ...snapshot(task),
      previousCheckpointMissing: Boolean(previous && (!previous.checkpoint || previous.checkpoint.phase === 'prepare'))
    };
  }

  checkpoint(token, checkpoint, sourceApplication = 'other') {
    const task = this.#task(token, sourceApplication);
    if (task.checkpoint?.phase === 'prepare') {
      if (!sameCheckpointClaim(task.checkpoint, checkpoint)) {
        throw checkpointConflict('Task checkpoint has different input');
      }
    } else if (task.checkpoint) {
      if (sameCheckpoint(task.checkpoint, checkpoint)) return snapshot(task);
      throw checkpointConflict(
        'Fuli task context has already been checkpointed with a different disposition'
      );
    }
    task.checkpoint = Object.freeze({ ...checkpoint, phase: 'complete' });
    return snapshot(task);
  }

  prepare(token, checkpoint, sourceApplication = 'other', agentMemory = null) {
    const task = this.#task(token, sourceApplication);
    if (agentMemory !== null && agentMemory !== undefined) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'The in-memory task context registry cannot atomically persist durable Agent memory'
      );
    }
    if (task.checkpoint && !sameCheckpointClaim(task.checkpoint, checkpoint)) {
      throw checkpointConflict('Task checkpoint has different input');
    }
    if (!task.checkpoint) task.checkpoint = { ...checkpoint, phase: 'prepare' };
    return snapshot(task);
  }

  context(token, sourceApplication = 'other') {
    return snapshot(this.#task(token, sourceApplication));
  }

  #task(token, sourceApplication) {
    assertNonEmpty(token, 'taskContextToken');
    const task = this.tokens.get(token);
    if (!task || task.sourceApplication !== sourceApplication) throw unknownTokenError();
    const key = sessionKey(task.sourceApplication, task.sessionId);
    if (this.sessions.get(key) !== task) throw unknownTokenError();
    this.sessions.delete(key);
    this.sessions.set(key, task);
    return task;
  }

  verify(sessionId, sourceApplication = 'other') {
    assertNonEmpty(sessionId, 'sessionId');
    const task = this.sessions.get(sessionKey(sourceApplication, sessionId));
    if (!task) {
      return {
        status: 'not_started',
        guidance: 'No Fuli task context was started; do not block the Agent.'
      };
    }
    if (task.checkpoint && task.checkpoint.phase !== 'prepare') {
      return {
        status: 'checkpointed',
        disposition: task.checkpoint.disposition
      };
    }
    return {
      status: 'checkpoint_required',
      decision: 'block',
      task_context_token: task.token,
      reason: `FULI_CHECKPOINT_REQUIRED: ${task.token} Before finishing, call checkpoint_task_knowledge once with either a bounded durable candidate batch or retain_nothing. Do not store raw transcripts, guesses, or temporary output.`
    };
  }

  #reserveSessionSlot() {
    if (this.sessions.size < MAX_ACTIVE_SESSIONS) return;
    for (const [key, task] of this.sessions) {
      if (task.checkpoint?.phase !== 'complete') continue;
      this.sessions.delete(key);
      this.tokens.delete(task.token);
      return;
    }
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      'Fuli has too many unfinished in-memory task contexts; finish an existing context or restart this fallback MCP process'
    );
  }
}

function snapshot(task) {
  return structuredClone(task);
}

function sessionKey(sourceApplication, sessionId) {
  return JSON.stringify([sourceApplication, sessionId]);
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      `${label} must be a nonempty string`
    );
  }
}

function sameCheckpoint(left, right) {
  return sameCheckpointClaim(left, right)
    && left.captureStatus === right.captureStatus;
}

function sameCheckpointClaim(left, right) {
  return left.fingerprint === right.fingerprint
    && left.disposition === right.disposition
    && left.reason === right.reason;
}

function checkpointConflict(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
