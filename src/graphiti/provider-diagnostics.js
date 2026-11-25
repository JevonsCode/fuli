import { workingProject } from './project-agent-mapping.js';

export const MAX_PROVIDER_VALIDATION_ERRORS = 5;

// The graph's data format refusal (rec#17) keeps its code and reason: the
// person has to upgrade, restore or confirm, which a bare 503 would hide.
const DATA_FORMAT_CODE = /^data_format_[a-z_]{1,40}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function providerErrorDiagnostic(status, payload) {
  const formatRefusal = DATA_FORMAT_CODE.test(payload?.detail?.code ?? '');
  const category = status >= 500 && status <= 599 && !formatRefusal
    ? 'provider_http_5xx'
    : 'provider_error';
  if (category === 'provider_http_5xx') {
    return {
      category,
      status,
      detail: `Graphiti provider returned HTTP ${status}.`
    };
  }
  const validationErrors = providerValidationErrors(payload);
  const deletedAt = payload?.detail?.deleted_at;
  return {
    category: typeof payload?.detail?.code === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(payload.detail.code)
      ? payload.detail.code : category,
    status,
    detail: payload?.detail?.code === 'replica_read_only'
      ? replicaReadOnlyMessage(payload.detail)
      : sanitizeProviderDetail(providerErrorMessage(payload, validationErrors)),
    validationErrors,
    // When hard-deleted knowledge was deleted (rec#5 C9): a timestamp, no content.
    ...(typeof deletedAt === 'string' && ISO_TIME.test(deletedAt) ? { deletedAt } : {}),
    ...nameTakenFields(payload?.detail)
  };
}

// A write the Provider refused because its record is a read-only copy of
// another computer's (graph-provider replica_write_guard.py): what it was, and
// what the person or the Agent does next.
function replicaReadOnlyMessage(detail) {
  // An export ID (`Label:key`): kept to the characters IDs use.
  const record = String(detail.record ?? '').replace(/[^\w.:@-]/g, '').slice(0, 120) || 'This record';
  return `${record} belongs to the computer this one follows and is only a read-only copy here; nothing was `
    + 'written. Make this change on that computer, or try again once this computer reaches it. '
    + '这是主机的内容：请在主机上改，或等这台电脑连上主机后再试。';
}

// A refused Agent name says who has it, where, and free names (graph-provider
// store_project_agent_naming.py name_taken), as fields the console shows as they are.
function nameTakenFields(detail) {
  if (detail?.code !== 'agent_name_taken' || !Array.isArray(detail.free_names)) return {};
  const text = value => String(value ?? '').slice(0, 160);
  return { nameTaken: {
    usedBy: (Array.isArray(detail.used_by) ? detail.used_by : []).slice(0, 8).map(item => ({
      agentId: text(item?.agent_id), name: text(item?.name),
      projects: (Array.isArray(item?.projects) ? item.projects : []).slice(0, 8).map(workingProject),
      // Someone's 原名: taken until free_from (an exact time).
      ...(item?.former_name && ISO_TIME.test(item?.free_from ?? '')
        ? { formerName: text(item.former_name), freeFrom: item.free_from } : {}) })),
    freeNames: detail.free_names.slice(0, 8).map(text) } };
}

// What a refusal says, for the human-review channel too (human-review-channel.js):
// validation failures name the field and reason, and paths, URLs and tokens are removed.
export function providerRefusalMessage(payload) {
  return sanitizeProviderDetail(providerErrorMessage(payload));
}

function providerErrorMessage(payload, validationErrors = providerValidationErrors(payload)) {
  if (typeof payload?.detail === 'string') return payload.detail;
  if (typeof payload?.detail?.message === 'string') return payload.detail.message;
  if (!validationErrors.length) return 'Graphiti provider request failed';
  const messages = validationErrors.map(({ field, message }) => (
    field ? `${field} — ${message}` : message
  ));
  return `Graphiti provider rejected the request — ${messages.join('; ')}`;
}

function sanitizeProviderDetail(value) {
  return String(value ?? 'Graphiti provider request failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s"']+/g, '<path>')
    .replace(/https?:\/\/[^\s"']+/gi, '<url>')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll(':', ' —')
    .slice(0, 320) || 'Graphiti provider request failed';
}

// Issue source: WZ.
// Provider validation failures must expose the field and actionable reason
// without echoing FastAPI's submitted input payload.
function providerValidationErrors(payload) {
  if (!Array.isArray(payload?.detail)) return [];
  return payload.detail
    .filter((item) => item && typeof item.msg === 'string' && item.msg.trim())
    .slice(0, MAX_PROVIDER_VALIDATION_ERRORS)
    .map((item) => ({
      field: validationLocation(item.loc),
      message: sanitizeProviderDetail(item.msg.trim()),
      // pydantic's error type (extra_forbidden, missing, ...): what kind of
      // refusal, so a caller can tell an unknown field from a wrong value.
      ...(typeof item.type === 'string' && VALIDATION_TYPE.test(item.type) ? { type: item.type } : {})
    }));
}

const VALIDATION_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

function validationLocation(loc) {
  if (!Array.isArray(loc)) return '';
  return loc
    .filter((segment) => segment !== 'body')
    .reduce((path, segment) => {
      if (typeof segment === 'number') return `${path}[${segment}]`;
      if (typeof segment !== 'string' || !segment) return path;
      return path ? `${path}.${segment}` : segment;
    }, '');
}
