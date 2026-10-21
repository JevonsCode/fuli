import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { writeJsonFileAtomic } from '../storage/json-file.js';
import { assertJsonFormatWritable, jsonFormat, updateVersionedJsonFileAtomic, writeVersionedJsonFileAtomic }
  from '../storage/json-format.js';
import { DEFAULT_PROJECT_SETTINGS, PROJECT_CHANGE_KEYS, storedProjectSettings, updatedProjectSettings,
  usesProjectModes } from './capture-project-mode.js';

// Capturing a client's sessions is separate from that client using FULI tools:
// a disabled source still queries existing memory, it just adds nothing new.
// This module stores the settings; capture-decision.js decides each write.
// Version 2 only when per-project modes are in use (rec#5 C2).
export const CAPTURE_POLICY_FORMAT = jsonFormat({ store: 'capture-policy', versions: [1, 2] });
const CAPTURE_GENERATION_FORMAT = jsonFormat({ store: 'capture-policy-generation', versions: [1] });
export const CAPTURE_SOURCES = Object.freeze(['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'other']);

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  disabledSources: [],
  ...DEFAULT_PROJECT_SETTINGS,
  updatedAt: null
});
const SETTING_KEYS = Object.freeze(['enabled', 'disabledSources', ...PROJECT_CHANGE_KEYS]);

const ABSENT = 'absent';
// Saves that keep landing while one change is merged; the change then fails instead of waiting longer.
const MAX_MERGE_ATTEMPTS = 5;
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
    this.memoryGeneration = 0;
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
    return { ...policy, disabledSources: [...policy.disabledSources], excludedProjectIds: [...policy.excludedProjectIds],
      selectedProjectIds: [...policy.selectedProjectIds], projectsOffSince: { ...policy.projectsOffSince } };
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
    if (!this.path) return `memory:${this.memoryGeneration}:${JSON.stringify(this.memory)}`;
    const observed = this.#fileKey();
    const stored = this.#readGeneration();
    if (stored === null && observed === ABSENT) return ABSENT;
    const current = stored?.observed === observed ? stored : this.#nextGeneration(stored, observed);
    return `${current.generation}:${current.nonce}`;
  }

  // No settings file and no generation: these settings were never saved
  // here, by any FULI version, so nothing has ever been recorded under them
  // (first-run detection, rec#5 C10). Unlike version() it writes nothing.
  neverSaved() {
    // Settings kept only in memory belong to no installation, so they never count as new.
    if (!this.path) return false;
    return this.#fileKey() === ABSENT && this.#readGeneration() === null;
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

  // A newer generation without a settings change, so every process treats
  // what it last recorded under the current one as stale. Throws when it
  // cannot be saved.
  advanceVersion() {
    if (!this.path) {
      this.memoryGeneration += 1;
      return;
    }
    this.#nextGeneration(this.#readGeneration(), this.#fileKey());
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
  // producing a value an earlier session already recorded. write(value) saves
  // it; by default under the directory's format lock.
  #nextGeneration(stored, observed,
    write = value => writeVersionedJsonFileAtomic(this.generationPath, value, CAPTURE_GENERATION_FORMAT)) {
    const next = { version: 1, generation: (stored?.generation ?? 0) + 1, nonce: randomUUID(), observed };
    try {
      write(next);
    } catch {
      throw new CapturePolicyConfigurationError('Capture settings generation could not be saved');
    }
    return next;
  }

  // A partial update: settings it does not name keep their current value, so
  // changing projects never turns recording back on, and the reverse. The
  // change is merged into the settings saved at the moment of writing: when
  // another process saved in between (its write is checked under the format
  // lock every save takes), the change is merged again into what it saved.
  // ifVersion: save only while the settings are still at that version();
  // accept(next): save only a result it accepts. Otherwise fail with code
  // capture_settings_changed.
  update(input, options) {
    return this.updateVersioned(input, options).settings;
  }

  // update() and the settings version its save produced, for a caller that
  // must bind to exactly that save (rec#5 C10): a later version() may already
  // include someone else's change.
  updateVersioned(input, { ifVersion = null, accept = () => true } = {}) {
    const changed = () => Object.assign(new Error('The capture settings changed'), { code: 'capture_settings_changed' });
    if (!this.path) {
      if (ifVersion !== null && this.version() !== ifVersion) throw changed();
      const { next } = this.preview(input);
      if (!accept(next)) throw changed();
      this.memory = next;
      return { settings: { ...next }, version: this.version() };
    }
    for (let attempt = 1; ; attempt += 1) {
      const base = this.#fileKey();
      const { next } = this.preview(input);
      // A repair from defaults must not replace settings a newer FULI saved (rec#17).
      // The save's generation is published under the same format lock as the
      // save itself, so the version returned names this file and no later
      // writer's (dot review, PR 266): every policy and generation write takes
      // that lock, so no other save can land between the two.
      let generation = null;
      const saved = updateVersionedJsonFileAtomic(this.path, CAPTURE_POLICY_FORMAT, () => {
        if (ifVersion !== null && this.#settledVersion() !== ifVersion) throw changed();
        if (!accept(next)) throw changed();
        return this.#fileKey() === base ? { version: usesProjectModes(next) ? 2 : 1, ...next } : undefined;
      }, { read: () => null, write: (path, value) => {
        writeJsonFileAtomic(path, value);
        generation = this.#nextGeneration(this.#readGeneration(), this.#fileKey(), this.#writeGenerationLocked);
      } });
      if (saved) return { settings: { ...next }, version: `${generation.generation}:${generation.nonce}` };
      if (attempt >= MAX_MERGE_ATTEMPTS) throw changed();
    }
  }

  // The generation write for a caller that already holds the format lock,
  // with the same newer-FULI guard the locked writer applies.
  #writeGenerationLocked = value => {
    assertJsonFormatWritable(this.generationPath, CAPTURE_GENERATION_FORMAT);
    writeJsonFileAtomic(this.generationPath, value);
  };

  // version() without moving the generation, for a check under the format
  // lock; null when the file changed since the generation last observed it.
  #settledVersion() {
    const observed = this.#fileKey();
    const stored = this.#readGeneration();
    if (stored === null && observed === ABSENT) return ABSENT;
    return stored?.observed === observed ? `${stored.generation}:${stored.nonce}` : null;
  }

  // The settings now and what update(input) would save, without saving it.
  preview(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Capture policy update must be an object');
    }
    const unknown = Object.keys(input).filter(key => !SETTING_KEYS.includes(key));
    if (unknown.length) throw new TypeError(`Capture policy has no setting ${unknown.join(', ')}`);
    if (SETTING_KEYS.every(key => input[key] === undefined)) {
      throw new TypeError('Capture policy update must name a setting to change');
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new TypeError('Capture policy enabled must be a boolean');
    }
    const current = this.#currentForUpdate(input);
    const now = this.now();
    return { current, next: {
      enabled: input.enabled ?? current.enabled,
      disabledSources: input.disabledSources === undefined
        ? current.disabledSources : validSources(input.disabledSources, TypeError),
      ...updatedProjectSettings(current, input, now),
      updatedAt: now
    } };
  }

  // Settings FULI cannot read record nothing until the person sets the global
  // switch again; that repair starts from the defaults for every setting it
  // does not name. A partial change without it cannot apply to unknown settings.
  #currentForUpdate(input) {
    try {
      return this.read();
    } catch (error) {
      if (!(error instanceof CapturePolicyConfigurationError) || input.enabled === undefined) throw error;
      return { ...DEFAULT_POLICY };
    }
  }
}

export function capturePolicyPathForRuntime(runtimeConfigPath) {
  if (!runtimeConfigPath) return null;
  return join(dirname(resolve(runtimeConfigPath)), 'capture-policy.json');
}

function validateStoredPolicy(value) {
  if (![1, 2].includes(value?.version) || typeof value.enabled !== 'boolean') {
    throw new CapturePolicyConfigurationError('Capture policy is invalid');
  }
  if (value.updatedAt !== null && typeof value.updatedAt !== 'string') {
    throw new CapturePolicyConfigurationError('Capture policy updatedAt is invalid');
  }
  return {
    enabled: value.enabled,
    // Policies saved before per-client capture capture every client.
    disabledSources: validSources(value.disabledSources ?? [], CapturePolicyConfigurationError),
    ...storedProjectSettings(value, CapturePolicyConfigurationError),
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
