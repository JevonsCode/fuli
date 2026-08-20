import { chmodSync } from 'node:fs';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

export const ADAPTIVE_RUNTIME_SETTINGS_VERSION = 1;

// These are product defaults, not measured hardware limits. They favor low idle
// memory while leaving enough time for short bursts of related Agent requests.
export const DEFAULT_ADAPTIVE_RUNTIME_SETTINGS = deepFreeze({
  version: ADAPTIVE_RUNTIME_SETTINGS_VERSION,
  enabled: false,
  providerIdleSeconds: 60,
  databaseIdleSeconds: 180,
  executorIdleSeconds: 60,
  leaseTtlSeconds: 180
});

export function readAdaptiveRuntimeSettings(path, {
  fallback = DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
  read = readJsonFile
} = {}) {
  if (!path) return normalizeAdaptiveRuntimeSettings(fallback);
  return normalizeAdaptiveRuntimeSettings(read(path, null) ?? fallback, { base: fallback });
}

export function writeAdaptiveRuntimeSettings(path, input, {
  write = writeJsonFileAtomic,
  secure = (filePath) => chmodSync(filePath, 0o600)
} = {}) {
  if (!path) throw new TypeError('Adaptive runtime settings path is required');
  const settings = normalizeAdaptiveRuntimeSettings(input, { strict: true });
  write(path, settings);
  secure(path);
  return settings;
}

export function normalizeAdaptiveRuntimeSettings(input, {
  base = DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
  strict = false
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Adaptive runtime settings must be an object');
  }
  if (
    input.version !== undefined &&
    input.version !== ADAPTIVE_RUNTIME_SETTINGS_VERSION
  ) {
    throw new TypeError('Unsupported adaptive runtime settings version');
  }
  if (strict && typeof input.enabled !== 'boolean') {
    throw new TypeError('enabled is required');
  }
  const enabled = input.enabled ?? base.enabled;
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const providerIdleSeconds = duration(
    input.providerIdleSeconds ?? base.providerIdleSeconds,
    'providerIdleSeconds',
    15,
    86_400
  );
  const databaseIdleSeconds = duration(
    input.databaseIdleSeconds ?? base.databaseIdleSeconds,
    'databaseIdleSeconds',
    providerIdleSeconds,
    604_800
  );
  const executorIdleSeconds = duration(
    input.executorIdleSeconds ?? base.executorIdleSeconds,
    'executorIdleSeconds',
    15,
    86_400
  );
  const leaseTtlSeconds = duration(
    input.leaseTtlSeconds ?? base.leaseTtlSeconds,
    'leaseTtlSeconds',
    30,
    3_600
  );
  return {
    version: ADAPTIVE_RUNTIME_SETTINGS_VERSION,
    enabled,
    providerIdleSeconds,
    databaseIdleSeconds,
    executorIdleSeconds,
    leaseTtlSeconds
  };
}

export function adaptiveRuntimeSettingsWithOverrides(settings, {
  enabled = null
} = {}) {
  return normalizeAdaptiveRuntimeSettings({
    ...settings,
    ...(enabled === null ? {} : { enabled })
  });
}

function duration(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}
