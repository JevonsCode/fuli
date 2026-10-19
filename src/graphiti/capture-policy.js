import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Capturing a client's sessions is separate from that client using FULI tools:
// a disabled source still queries existing memory, it just adds nothing new.
// This module stores the settings; capture-decision.js decides each write.
export const CAPTURE_SOURCES = Object.freeze(['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'other']);

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  disabledSources: [],
  updatedAt: null
});

const ABSENT = 'absent';
const UNREADABLE = Object.freeze({ generation: 0 });

export class CapturePolicyConfigurationError extends TypeError {}

export class CapturePolicyStore {
  constructor(path = null, {
    now = () => new Date().toISOString(),
    readText = file => readFileSync(file, 'utf8'),
    statFile = file => statSync(file, { bigint: true })
  } = {}) {
    this.path = path ? resolve(path) : null;
    this.now = now;
    this.readText = readText;
    this.statFile = statFile;
    this.memory = { ...DEFAULT_POLICY };
    this.parsed = null;
    this.generationPath = this.path ? join(dirname(this.path), 'capture-settings-generation.json') : null;
  }

  // Every write asks for a decision, so one hook reads the settings several
  // times. The file is parsed again only when its identity, size or times
  // change; a file that cannot be read or parsed is never served from cache.
  read() {
    if (!this.path) return { ...this.memory };
    const version = this.#fileKey();
    if (version === ABSENT) {
      this.parsed = null;
      return { ...DEFAULT_POLICY };
    }
    if (this.parsed?.version !== version) {
      this.parsed = null;
      let value;
      try {
        value = JSON.parse(this.readText(this.path));
      } catch (error) {
        if (error?.code === 'ENOENT') return { ...DEFAULT_POLICY };
        throw new CapturePolicyConfigurationError('Capture policy could not be read');
      }
      this.parsed = { version, policy: validateStoredPolicy(value) };
    }
    const { policy } = this.parsed;
    return { ...policy, disabledSources: [...policy.disabledSources] };
  }

  // The settings generation: persistent and monotonic, kept beside (not in)
  // capture-policy.json. Every update() moves it, and so does any change seen
  // in the file (a hand edit, a restore, a removed file), so settings that
  // once existed never look "never saved" ('absent'). Comparing only the
  // current file would miss an off-to-on cycle no hook observed. This is one
  // global generation: any change moves it for every client. A later step
  // scopes generations per global, client, project and session layer, each
  // persistent and monotonic, not a fingerprint of the final switch.
  version() {
    if (!this.path) return `memory:${JSON.stringify(this.memory)}`;
    const observed = this.#fileKey();
    const stored = this.#readGeneration();
    if (stored === null && observed === ABSENT) return ABSENT;
    const current = stored?.observed === observed ? stored : this.#nextGeneration(stored, observed);
    return `${current.generation}:${current.nonce}`;
  }

  #fileKey() {
    try {
      const stat = this.statFile(this.path);
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (error?.code === 'ENOENT') return ABSENT;
      throw new CapturePolicyConfigurationError('Capture policy could not be read');
    }
  }

  // A missing generation is null; an unreadable one is replaced by a newer one.
  #readGeneration() {
    let value;
    try {
      value = JSON.parse(readFileSync(this.generationPath, 'utf8'));
    } catch (error) {
      return error?.code === 'ENOENT' ? null : UNREADABLE;
    }
    return value?.version === 1 && Number.isSafeInteger(value.generation) && value.generation > 0
      && typeof value.nonce === 'string' && typeof value.observed === 'string' ? value : UNREADABLE;
  }

  // The nonce keeps two processes that move the same generation at once from
  // producing a value an earlier session already recorded.
  #nextGeneration(stored, observed) {
    const next = { version: 1, generation: (stored?.generation ?? 0) + 1, nonce: randomUUID(), observed };
    try {
      writeAtomically(this.generationPath, next);
    } catch {
      throw new CapturePolicyConfigurationError('Capture settings generation could not be saved');
    }
    return next;
  }

  update(input) {
    if (!input || typeof input.enabled !== 'boolean') {
      throw new TypeError('Capture policy enabled must be a boolean');
    }
    const next = {
      enabled: input.enabled,
      disabledSources: input.disabledSources === undefined
        ? this.read().disabledSources : validSources(input.disabledSources, TypeError),
      updatedAt: this.now()
    };
    if (!this.path) {
      this.memory = next;
      return { ...next };
    }
    writeAtomically(this.path, { version: 1, ...next });
    this.#nextGeneration(this.#readGeneration(), this.#fileKey());
    return { ...next };
  }
}

export function capturePolicyPathForRuntime(runtimeConfigPath) {
  if (!runtimeConfigPath) return null;
  return join(dirname(resolve(runtimeConfigPath)), 'capture-policy.json');
}

function validateStoredPolicy(value) {
  if (value?.version !== 1 || typeof value.enabled !== 'boolean') {
    throw new CapturePolicyConfigurationError('Capture policy is invalid');
  }
  if (value.updatedAt !== null && typeof value.updatedAt !== 'string') {
    throw new CapturePolicyConfigurationError('Capture policy updatedAt is invalid');
  }
  return {
    enabled: value.enabled,
    // Policies saved before per-client capture capture every client.
    disabledSources: validSources(value.disabledSources ?? [], CapturePolicyConfigurationError),
    updatedAt: value.updatedAt ?? null
  };
}

function validSources(value, ErrorType) {
  if (!Array.isArray(value) || value.some(source => !CAPTURE_SOURCES.includes(source))
    || new Set(value).size !== value.length) {
    throw new ErrorType('Capture policy disabledSources must list distinct supported clients');
  }
  return [...value].sort();
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
