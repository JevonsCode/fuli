import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  updatedAt: null
});

export class AgentAccessPolicyConfigurationError extends TypeError {}

export class AgentAccessPolicyStore {
  constructor(path = null, { now = () => new Date().toISOString() } = {}) {
    this.path = path ? resolve(path) : null;
    this.now = now;
    this.memory = { ...DEFAULT_POLICY };
  }

  read() {
    if (!this.path) return { ...this.memory };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULT_POLICY };
      throw new AgentAccessPolicyConfigurationError(
        'Agent access policy could not be read'
      );
    }
    return validateStoredPolicy(parsed);
  }

  update(input) {
    if (!input || typeof input.enabled !== 'boolean') {
      throw new TypeError('Agent access policy enabled must be a boolean');
    }
    const next = {
      enabled: input.enabled,
      updatedAt: this.now()
    };
    if (!this.path) {
      this.memory = next;
      return { ...next };
    }
    writeAtomically(this.path, { version: 1, ...next });
    return { ...next };
  }
}

export function agentAccessPolicyPathForRuntime(runtimeConfigPath) {
  if (!runtimeConfigPath) return null;
  return join(dirname(resolve(runtimeConfigPath)), 'agent-access-policy.json');
}

function validateStoredPolicy(value) {
  if (value?.version !== 1 || typeof value.enabled !== 'boolean') {
    throw new AgentAccessPolicyConfigurationError('Agent access policy is invalid');
  }
  if (value.updatedAt !== null && typeof value.updatedAt !== 'string') {
    throw new AgentAccessPolicyConfigurationError(
      'Agent access policy updatedAt is invalid'
    );
  }
  return {
    enabled: value.enabled,
    updatedAt: value.updatedAt ?? null
  };
}

function writeAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
