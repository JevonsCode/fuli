import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

export const ADAPTIVE_RUNTIME_STATE_VERSION = 1;
export const ADAPTIVE_RUNTIME_STAGES = Object.freeze([
  'always-on',
  'awake',
  'provider-sleeping',
  'sleeping',
  'waking',
  'degraded'
]);

export function readAdaptiveRuntimeState(path, {
  read = readJsonFile
} = {}) {
  if (!path) return null;
  try {
    return normalizeAdaptiveRuntimeState(read(path, null));
  } catch {
    return null;
  }
}

export function writeAdaptiveRuntimeState(path, state, {
  write = writeJsonFileAtomic
} = {}) {
  if (!path) return null;
  const normalized = normalizeAdaptiveRuntimeState(state, { required: true });
  write(path, normalized);
  return normalized;
}

export function initialAdaptiveRuntimeState({ enabled, now = new Date() }) {
  const timestamp = dateIso(now);
  return {
    version: ADAPTIVE_RUNTIME_STATE_VERSION,
    stage: enabled ? 'awake' : 'always-on',
    lastActivityAt: timestamp,
    updatedAt: timestamp,
    lastError: null
  };
}

export function normalizeAdaptiveRuntimeState(input, { required = false } = {}) {
  if (input == null && !required) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Adaptive runtime state must be an object');
  }
  if (input.version !== ADAPTIVE_RUNTIME_STATE_VERSION) {
    throw new TypeError('Unsupported adaptive runtime state version');
  }
  if (!ADAPTIVE_RUNTIME_STAGES.includes(input.stage)) {
    throw new TypeError('Unsupported adaptive runtime stage');
  }
  return {
    version: ADAPTIVE_RUNTIME_STATE_VERSION,
    stage: input.stage,
    lastActivityAt: dateIso(input.lastActivityAt),
    updatedAt: dateIso(input.updatedAt),
    lastError: optionalText(input.lastError, 500)
  };
}

function dateIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Adaptive runtime date is invalid');
  return date.toISOString();
}

function optionalText(value, maximumLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Adaptive runtime error must be text');
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximumLength) || null;
}
