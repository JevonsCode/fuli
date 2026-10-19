import { dirname, join, resolve } from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

// How hosts use automatic recall. With answerFromConfirmed on, items a person
// confirmed are answered from directly instead of being re-checked in files;
// people who want every answer verified against the files turn it off.
const DEFAULT_POLICY = Object.freeze({ answerFromConfirmed: true, updatedAt: null });

export class RecallPolicyConfigurationError extends TypeError {}

export class RecallPolicyStore {
  constructor(path = null, { now = () => new Date().toISOString() } = {}) {
    this.path = path ? resolve(path) : null;
    this.now = now;
    this.memory = { ...DEFAULT_POLICY };
  }

  read() {
    if (!this.path) return { ...this.memory };
    let stored;
    try {
      stored = readJsonFile(this.path, null);
    } catch {
      throw new RecallPolicyConfigurationError('Recall policy could not be read');
    }
    if (stored === null) return { ...DEFAULT_POLICY };
    if (stored?.version !== 1 || typeof stored.answerFromConfirmed !== 'boolean'
      || (stored.updatedAt !== null && typeof stored.updatedAt !== 'string')) {
      throw new RecallPolicyConfigurationError('Recall policy is invalid');
    }
    return { answerFromConfirmed: stored.answerFromConfirmed, updatedAt: stored.updatedAt };
  }

  update(input) {
    if (typeof input?.answerFromConfirmed !== 'boolean') {
      throw new TypeError('Recall policy answerFromConfirmed must be a boolean');
    }
    const next = { answerFromConfirmed: input.answerFromConfirmed, updatedAt: this.now() };
    if (this.path) writeJsonFileAtomic(this.path, { version: 1, ...next });
    else this.memory = next;
    return { ...next };
  }
}

export function recallPolicyPathForRuntime(runtimeConfigPath) {
  return runtimeConfigPath ? join(dirname(resolve(runtimeConfigPath)), 'recall-policy.json') : null;
}
