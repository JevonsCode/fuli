import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { jsonFormat } from '../storage/json-format.js';
import { readJsonFile } from '../storage/json-file.js';
import {
  assertJsonObject, deepFreeze, positiveInteger, requiredString, uniqueTextArray
} from '../validation/values.js';
import { secretReference } from './secret-store.js';

// Optional per-role model backends for the four built-in Agents. The file
// holds connections and role settings only; keys live in the secret store and
// are named here by secretRef. A missing file or roles section configures no
// role, so older installations keep using the current session.

export const MODEL_BACKEND_ROLES = Object.freeze(['assistant', 'bole', 'jefa', 'tonborg']);
const MODEL_BACKEND_PROTOCOLS = Object.freeze(['openai_chat', 'anthropic_messages', 'typesafe_systemone']);
export const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

const CONFIG_VERSION = 1;
// FULI writes this file when the person saves a role in the console.
export const MODEL_BACKEND_CONFIG_FORMAT = jsonFormat({ store: 'model-backends', versions: [CONFIG_VERSION] });
const MAX_CONNECTIONS = 32;
const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const KEYED_PROTOCOLS = new Set(['anthropic_messages', 'typesafe_systemone']);
// OpenAI-compatible reasoning_effort; 'none' keeps a thinking model such as
// qwen3.5 from spending the output budget on hidden reasoning.
const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high']);
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_OPERATIONS = 32;
const MAX_APPROVED_PROJECTS = 256;
const MIN_TIMEOUT_MS = 1000;
const BUDGET_LIMITS = Object.freeze({
  maxInputTokens: 2_000_000, maxOutputTokens: 200_000, timeoutMs: 600_000,
  windowHours: 744, maxTokensPerWindow: 10_000_000_000
});

// { state: 'absent' } | { state: 'invalid', error } | { state: 'ok', config }.
// An invalid file is a repairable error, never the same as no file.
export function readModelBackendConfig(path, { read = readJsonFile } = {}) {
  let raw;
  try {
    raw = read(path, null);
  } catch {
    return { state: 'invalid', error: 'model-backends.json could not be read as JSON' };
  }
  if (raw === null || raw === undefined) return { state: 'absent' };
  try {
    return { state: 'ok', config: deepFreeze(normalizeConfig(raw)) };
  } catch (error) {
    if (error instanceof TypeError) return { state: 'invalid', error: error.message };
    throw error;
  }
}

// Which saved configuration an edit starts from; null when there is none.
export function configRevision(loaded) {
  return loaded.state === 'ok' ? contentHash(loaded.config) : null;
}

// Which configured connection served an answer (rec#10 D-36): its id,
// protocol, normalized endpoint and model, as one comparable value. A role
// trusts an answer only while its configuration still names the same one, so
// the same model name on another connection, or an endpoint changed in
// place, is a different identity. A digest, so no endpoint leaves the port.
export function connectionIdentity(id, connection) {
  return contentHash({ id, protocol: connection.protocol, endpoint: connection.endpoint, model: connection.model });
}

// Validates a whole configuration, throwing a TypeError that names the field.
// Its result reads back to itself, so it is also what FULI writes.
export function normalizeConfig(raw) {
  object(raw, 'model backend config', ['version', 'connections', 'roles']);
  if (raw.version !== CONFIG_VERSION) throw new TypeError(`model backend config version must be ${CONFIG_VERSION}`);
  const connections = normalizeConnections(raw.connections ?? {});
  const roles = object(raw.roles ?? {}, 'roles');
  for (const role of Object.keys(roles)) {
    if (!MODEL_BACKEND_ROLES.includes(role)) {
      throw new TypeError(`roles.${role} is not a built-in Agent role (${MODEL_BACKEND_ROLES.join(', ')})`);
    }
  }
  return {
    version: CONFIG_VERSION,
    connections,
    roles: Object.fromEntries(Object.entries(roles).map(([role, value]) =>
      [role, normalizeRole(value, `roles.${role}`, connections)]))
  };
}

function normalizeConnections(value) {
  const entries = Object.entries(object(value, 'connections'));
  if (entries.length > MAX_CONNECTIONS) throw new TypeError(`connections may contain at most ${MAX_CONNECTIONS} entries`);
  return Object.fromEntries(entries.map(([id, connection]) => {
    if (!CONNECTION_ID_PATTERN.test(id)) throw new TypeError(`connections.${id} must be named with letters, digits, dots, dashes or underscores`);
    return [id, normalizeConnection(connection, `connections.${id}`)];
  }));
}

function normalizeConnection(value, label) {
  object(value, label, ['protocol', 'endpoint', 'model', 'secretRef', 'reasoningEffort', 'pricing']);
  if (!MODEL_BACKEND_PROTOCOLS.includes(value.protocol)) {
    throw new TypeError(`${label}.protocol must be one of ${MODEL_BACKEND_PROTOCOLS.join(', ')}`);
  }
  const secretRef = value.secretRef === null || value.secretRef === undefined
    ? null : secretReference(value.secretRef, `${label}.secretRef`);
  if (!secretRef && KEYED_PROTOCOLS.has(value.protocol)) {
    throw new TypeError(`${label}.secretRef is required for ${value.protocol}`);
  }
  const reasoningEffort = value.reasoningEffort ?? null;
  if (reasoningEffort !== null && (value.protocol !== 'openai_chat' || !REASONING_EFFORTS.includes(reasoningEffort))) {
    throw new TypeError(`${label}.reasoningEffort is only for openai_chat and must be one of ${REASONING_EFFORTS.join(', ')}`);
  }
  return {
    protocol: value.protocol,
    endpoint: endpointUrl(value.endpoint, `${label}.endpoint`),
    model: plainText(value.model, `${label}.model`, 200),
    secretRef,
    reasoningEffort,
    pricing: value.pricing == null ? null : normalizePricing(value.pricing, `${label}.pricing`)
  };
}

function endpointUrl(value, label) {
  const text = requiredString(value, label, 2048);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (url.username || url.password) throw new TypeError(`${label} must not contain credentials; use secretRef`);
  if (url.search || url.hash) throw new TypeError(`${label} must not contain a query or fragment`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new TypeError(`${label} must use HTTPS or loopback HTTP`);
  }
  return url.href.replace(/\/+$/, '');
}

// Unit prices per million tokens. Without them every cost is unknown.
function normalizePricing(value, label) {
  object(value, label, ['currency', 'inputPerMillionTokens', 'outputPerMillionTokens', 'cachedInputPerMillionTokens']);
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) {
    throw new TypeError(`${label}.currency must be a three-letter currency code`);
  }
  return {
    currency: value.currency,
    inputPerMillionTokens: price(value.inputPerMillionTokens, `${label}.inputPerMillionTokens`),
    outputPerMillionTokens: price(value.outputPerMillionTokens, `${label}.outputPerMillionTokens`),
    cachedInputPerMillionTokens: value.cachedInputPerMillionTokens == null
      ? null : price(value.cachedInputPerMillionTokens, `${label}.cachedInputPerMillionTokens`)
  };
}

function normalizeRole(value, label, connections) {
  object(value, label, ['enabled', 'connection', 'allowedOperations', 'egress', 'budget', 'fallbackToSession']);
  if (typeof value.enabled !== 'boolean') throw new TypeError(`${label}.enabled must be a boolean`);
  const connection = requiredString(value.connection, `${label}.connection`, 64);
  if (!Object.hasOwn(connections, connection)) {
    throw new TypeError(`${label}.connection names a missing connection: ${connection}`);
  }
  const allowedOperations = uniqueTextArray(value.allowedOperations, `${label}.allowedOperations`, MAX_OPERATIONS);
  if (allowedOperations.some(operation => !OPERATION_PATTERN.test(operation))) {
    throw new TypeError(`${label}.allowedOperations must contain lowercase operation names such as staffing_review`);
  }
  const budget = value.budget == null ? null
    : normalizeBudget(value.budget, `${label}.budget`, connections[connection]);
  if (value.enabled && !budget) throw new TypeError(`${label}.budget is required for an enabled role`);
  const fallbackToSession = value.fallbackToSession ?? false;
  if (typeof fallbackToSession !== 'boolean') throw new TypeError(`${label}.fallbackToSession must be a boolean`);
  return {
    enabled: value.enabled, connection, allowedOperations,
    egress: normalizeEgress(value.egress, `${label}.egress`), budget, fallbackToSession
  };
}

// Default: no project content leaves the computer. Each project is approved
// on its own; content without a project needs its own approval.
function normalizeEgress(value, label) {
  if (value === undefined) return { approvedProjects: [], allowUnassigned: false };
  object(value, label, ['approvedProjects', 'allowUnassigned']);
  const projects = value.approvedProjects ?? [];
  if (!Array.isArray(projects) || projects.length > MAX_APPROVED_PROJECTS) {
    throw new TypeError(`${label}.approvedProjects must be an array of at most ${MAX_APPROVED_PROJECTS} projects`);
  }
  const allowUnassigned = value.allowUnassigned ?? false;
  if (typeof allowUnassigned !== 'boolean') throw new TypeError(`${label}.allowUnassigned must be a boolean`);
  return {
    approvedProjects: projects.map((project, index) => {
      const itemLabel = `${label}.approvedProjects[${index}]`;
      object(project, itemLabel, ['personalSpaceId', 'personalProjectId']);
      return {
        personalSpaceId: requiredString(project.personalSpaceId, `${itemLabel}.personalSpaceId`, 256),
        personalProjectId: requiredString(project.personalProjectId, `${itemLabel}.personalProjectId`, 256)
      };
    }),
    allowUnassigned
  };
}

function normalizeBudget(value, label, connection) {
  object(value, label, [...Object.keys(BUDGET_LIMITS), 'maxCostPerWindow']);
  const budget = Object.fromEntries(Object.entries(BUDGET_LIMITS).map(([key, maximum]) =>
    [key, positiveInteger(value[key], `${label}.${key}`, maximum)]));
  if (budget.timeoutMs < MIN_TIMEOUT_MS) throw new TypeError(`${label}.timeoutMs must be at least ${MIN_TIMEOUT_MS}`);
  if (value.maxCostPerWindow == null) return { ...budget, maxCostPerWindow: null };
  if (!connection.pricing) {
    throw new TypeError(`${label}.maxCostPerWindow needs unit prices on the connection; without them the cost is unknown (费用未知)`);
  }
  const maxCostPerWindow = price(value.maxCostPerWindow, `${label}.maxCostPerWindow`);
  if (maxCostPerWindow === 0) throw new TypeError(`${label}.maxCostPerWindow must be greater than 0`);
  return { ...budget, maxCostPerWindow };
}

function object(value, label, allowedKeys = null) {
  assertJsonObject(value, label);
  for (const key of allowedKeys ? Object.keys(value) : []) {
    if (!allowedKeys.includes(key)) throw new TypeError(`${label}.${key} is not a supported field`);
  }
  return value;
}

function plainText(value, label, maximum) {
  const text = requiredString(value, label, maximum);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new TypeError(`${label} must be plain text`);
  return text;
}

function price(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
  return value;
}
