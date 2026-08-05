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

  begin({ sessionId, personalProjectId }) {
    assertNonEmpty(sessionId, 'sessionId');
    const previous = this.sessions.get(sessionId) ?? null;
    if (previous) this.tokens.delete(previous.token);

    const task = {
      token: this.tokenFactory(),
      sessionId,
      personalProjectId: personalProjectId ?? null,
      checkpoint: null
    };
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, task);
    this.tokens.set(task.token, task);
    this.#evictOldest();
    return {
      ...task,
      previousCheckpointMissing: Boolean(previous && !previous.checkpoint)
    };
  }

  checkpoint(token, checkpoint) {
    assertNonEmpty(token, 'taskContextToken');
    const task = this.tokens.get(token);
    if (!task) throw unknownTokenError();
    if (task.checkpoint) {
      if (sameCheckpoint(task.checkpoint, checkpoint)) return task;
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Fuli task context has already been checkpointed with a different disposition'
      );
    }
    task.checkpoint = Object.freeze({ ...checkpoint });
    return task;
  }

  context(token) {
    assertNonEmpty(token, 'taskContextToken');
    const task = this.tokens.get(token);
    if (!task) throw unknownTokenError();
    return task;
  }

  verify(sessionId) {
    assertNonEmpty(sessionId, 'sessionId');
    const task = this.sessions.get(sessionId);
    if (!task) {
      return {
        status: 'not_started',
        guidance: 'No Fuli task context was started; do not block the Agent.'
      };
    }
    if (task.checkpoint) {
      return {
        status: 'checkpointed',
        disposition: task.checkpoint.disposition
      };
    }
    return {
      status: 'checkpoint_required',
      decision: 'block',
      reason: 'Before finishing, call checkpoint_task_knowledge once with either a bounded durable candidate batch or retain_nothing. Do not store raw transcripts, guesses, or temporary output.'
    };
  }

  #evictOldest() {
    while (this.sessions.size > MAX_ACTIVE_SESSIONS) {
      const [sessionId, task] = this.sessions.entries().next().value;
      this.sessions.delete(sessionId);
      this.tokens.delete(task.token);
    }
  }
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

function sameCheckpoint(left, right) {
  return left.disposition === right.disposition
    && left.reason === right.reason
    && left.captureStatus === right.captureStatus;
}
