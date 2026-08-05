import { chmodSync } from 'node:fs';

import { isFetchBlockedPort } from '../server/blocked-ports.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

export const RUNTIME_SETTINGS_VERSION = 1;
export const RESOURCE_REFRESH_OPTIONS = Object.freeze([5, 10, 30, 60]);
export const CONVERSATION_LAUNCHER_APPLICATIONS = Object.freeze([
  'codex',
  'claude_code',
  'cursor',
  'gemini_cli',
  'kiro',
  'other'
]);
export const CONVERSATION_ID_FORMATS = Object.freeze(['any', 'uuid']);
export const PORT_KEYS = Object.freeze([
  'console',
  'personalProvider',
  'personalNeo4jHttp',
  'personalNeo4jBolt',
  'workspaceProvider',
  'workspaceNeo4jHttp',
  'workspaceNeo4jBolt'
]);

export const DEFAULT_CONVERSATION_LAUNCHERS = deepFreeze({
  codex: {
    enabled: true,
    idFormat: 'uuid',
    appName: 'Codex',
    urlTemplate: 'codex://threads/{id}'
  },
  claude_code: {
    enabled: false,
    idFormat: 'any',
    appName: 'Claude Code',
    urlTemplate: ''
  },
  cursor: {
    enabled: false,
    idFormat: 'any',
    appName: 'Cursor',
    urlTemplate: ''
  },
  gemini_cli: {
    enabled: false,
    idFormat: 'any',
    appName: 'Gemini CLI',
    urlTemplate: ''
  },
  kiro: {
    enabled: false,
    idFormat: 'any',
    appName: 'Kiro',
    urlTemplate: ''
  },
  other: {
    enabled: false,
    idFormat: 'any',
    appName: 'Other Agent',
    urlTemplate: ''
  }
});

export const DEFAULT_RUNTIME_SETTINGS = deepFreeze({
  version: RUNTIME_SETTINGS_VERSION,
  ports: {
    console: 2727,
    personalProvider: 8787,
    personalNeo4jHttp: 8060,
    personalNeo4jBolt: 7687,
    workspaceProvider: 8788,
    workspaceNeo4jHttp: 7475,
    workspaceNeo4jBolt: 7688
  },
  lanAccess: false,
  resourceRefreshSeconds: 5,
  conversationLaunchers: DEFAULT_CONVERSATION_LAUNCHERS
});

export function readRuntimeSettings(path, {
  fallback = DEFAULT_RUNTIME_SETTINGS,
  read = readJsonFile
} = {}) {
  const stored = read(path, null);
  return normalizeRuntimeSettings(stored ?? fallback, { base: fallback });
}

export function writeRuntimeSettings(path, input, {
  write = writeJsonFileAtomic,
  secure = (filePath) => chmodSync(filePath, 0o600)
} = {}) {
  const settings = normalizeRuntimeSettings(input, { strict: true });
  write(path, settings);
  secure(path);
  return settings;
}

export function normalizeRuntimeSettings(input, {
  base = DEFAULT_RUNTIME_SETTINGS,
  strict = false
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Runtime settings must be an object');
  }
  if (input.version !== undefined && input.version !== RUNTIME_SETTINGS_VERSION) {
    throw new TypeError('Unsupported runtime settings version');
  }
  const portsInput = input.ports;
  if (strict && (!portsInput || typeof portsInput !== 'object' || Array.isArray(portsInput))) {
    throw new TypeError('ports is required');
  }
  const ports = {};
  for (const key of PORT_KEYS) {
    const value = portsInput?.[key] ?? base.ports[key];
    ports[key] = validPort(value, key);
  }
  const uniquePorts = new Set(Object.values(ports));
  if (uniquePorts.size !== PORT_KEYS.length) {
    throw new TypeError('Every FULI service must use a different port');
  }
  if (isFetchBlockedPort(ports.console)) {
    throw new TypeError('The management UI port is blocked by web browsers');
  }

  const lanAccess = input.lanAccess ?? base.lanAccess;
  if (typeof lanAccess !== 'boolean') throw new TypeError('lanAccess must be a boolean');
  const resourceRefreshSeconds = input.resourceRefreshSeconds ?? base.resourceRefreshSeconds;
  if (!RESOURCE_REFRESH_OPTIONS.includes(resourceRefreshSeconds)) {
    throw new TypeError('resourceRefreshSeconds must be 5, 10, 30, or 60');
  }
  const conversationLaunchers = normalizeConversationLaunchers(
    input.conversationLaunchers,
    { base: base.conversationLaunchers ?? DEFAULT_CONVERSATION_LAUNCHERS }
  );
  return {
    version: RUNTIME_SETTINGS_VERSION,
    ports,
    lanAccess,
    resourceRefreshSeconds,
    conversationLaunchers
  };
}

export function normalizeConversationLaunchers(input, {
  base = DEFAULT_CONVERSATION_LAUNCHERS
} = {}) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError('conversationLaunchers must be an object');
  }
  for (const key of Object.keys(input ?? {})) {
    if (!CONVERSATION_LAUNCHER_APPLICATIONS.includes(key)) {
      throw new TypeError(`Unsupported conversation launcher: ${key}`);
    }
  }
  return Object.fromEntries(CONVERSATION_LAUNCHER_APPLICATIONS.map((application) => {
    const fallback = base[application] ?? DEFAULT_CONVERSATION_LAUNCHERS[application];
    const candidate = input?.[application] ?? fallback;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`${application} conversation launcher must be an object`);
    }
    const enabled = candidate.enabled ?? fallback.enabled;
    if (typeof enabled !== 'boolean') {
      throw new TypeError(`${application} conversation launcher enabled must be a boolean`);
    }
    const idFormat = candidate.idFormat ?? fallback.idFormat;
    if (!CONVERSATION_ID_FORMATS.includes(idFormat)) {
      throw new TypeError(`${application} conversation launcher idFormat is unsupported`);
    }
    const appName = launcherText(
      candidate.appName ?? fallback.appName,
      `${application} conversation launcher appName`,
      64
    );
    const urlTemplate = launcherText(
      candidate.urlTemplate ?? fallback.urlTemplate,
      `${application} conversation launcher urlTemplate`,
      1024
    );
    if (enabled && !appName) {
      throw new TypeError(`${application} conversation launcher appName is required`);
    }
    if (urlTemplate && !validConversationUrlTemplate(urlTemplate)) {
      throw new TypeError(
        `${application} conversation launcher urlTemplate must use a safe URL scheme and contain {id}`
      );
    }
    if (enabled && !urlTemplate) {
      throw new TypeError(`${application} conversation launcher urlTemplate is required`);
    }
    return [application, { enabled, idFormat, appName, urlTemplate }];
  }));
}

export function runtimeSettingsWithOverrides(settings, {
  consolePort = null,
  lanAccess = null
} = {}) {
  return normalizeRuntimeSettings({
    ...settings,
    ports: {
      ...settings.ports,
      ...(consolePort === null ? {} : { console: consolePort })
    },
    ...(lanAccess === null ? {} : { lanAccess })
  });
}

export function managedProviderUrls(settings) {
  return {
    personal: `http://127.0.0.1:${settings.ports.personalProvider}`,
    workspace: `http://127.0.0.1:${settings.ports.workspaceProvider}`
  };
}

export function runtimeSettingsEqual(left, right) {
  return JSON.stringify(normalizeRuntimeSettings(left)) ===
    JSON.stringify(normalizeRuntimeSettings(right));
}

function validPort(value, key) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError(`${key} must be an integer between 1 and 65535`);
  }
  return value;
}

function launcherText(value, label, maximumLength) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maximumLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new TypeError(`${label} is invalid`);
  }
  return trimmed;
}

function validConversationUrlTemplate(value) {
  if (value.split('{id}').length !== 2 || /\s/.test(value)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return Boolean(scheme) && !['about', 'blob', 'data', 'file', 'javascript'].includes(scheme);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}
