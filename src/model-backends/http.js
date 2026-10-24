import { z } from 'zod';

import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { positiveInteger } from '../validation/values.js';
import { MODEL_BACKEND_ROLES } from './config.js';
import { MAX_HISTORY_LIMIT } from './settings-history.js';
import { RETENTION } from './suggestion-log.js';

// Routes of the model settings page. The roles and usage reads are
// Agent-readable and contain no secrets, but include metadata (endpoints,
// prices, approved projects); get_model_usage reads the same port. Saving one
// role, its 「只给建议」 switch or the acknowledgement of its trust warning is
// accepted only at the local process boundary (a loopback request). That
// does not show a person sent it and is not the human-review channel: no MCP
// or Agent tool calls it, but anything with local shell or HTTP access can.
// Keys stay a local command (fuli models set-key).
// operations: the task types each role already sends to its model.
// automaticOperations: the one operation per role that may apply its model's
// answer by itself (rec#10 D-36); modelTrust (src/model-backends/role-trust.js)
// says whether it does now. readEvaluation(key): the latest evaluation of that
// role's model on this computer (evaluation-record.js), or null.
// localBuild: what a local Ollama listed for each role's configured model at
// its latest answer (rec#10 D-32), read-only: an observation, never proof.
// suggestions lists what Astro, Bole and Jefa showed after asking their own
// model (suggestion-log.js), newest first, a limit clamped to RETENTION.rows, with
// its retention; it is a read only, and no route writes it. history lists
// what changed in a role's settings and execution mode and when
// (settings-history.js, rec#11 D-42), newest first, read only; each save and
// trust change answers whether its change was recorded there.
const ROLE_ROUTE = /^\/api\/model-backends\/roles\/([a-z]+)$/;
const TRUST_ROUTE = /^\/api\/model-backends\/roles\/([a-z]+)\/trust$/;
const SUGGESTIONS_ROUTE = '/api/model-backends/suggestions';
const HISTORY_ROUTE = '/api/model-backends/history';
const READ_ROUTES = ['/api/model-backends/usage', '/api/model-backends/roles', SUGGESTIONS_ROUTE, HISTORY_ROUTE];
const revision = z.number().int().min(0);
const TRUST_EDIT = z.union([
  z.object({ expectedRevision: revision, suggestionsOnly: z.boolean() }).strict(),
  z.object({ expectedRevision: revision, acknowledgeWarning: z.number().int().min(1) }).strict()
]);

export async function handleModelBackendApiRequest({
  request, response, url, modelBackends, roleWork = null, readRoleSuggestions = null, roleSettings = null, operations = {},
  automaticOperations = {}, modelTrust = null, settingsHistory = null, readEvaluation = null
}) {
  const roleEdit = ROLE_ROUTE.exec(url.pathname)?.[1] ?? null;
  const trustEdit = TRUST_ROUTE.exec(url.pathname)?.[1] ?? null;
  if (!roleEdit && !trustEdit && !READ_ROUTES.includes(url.pathname)) return false;
  if (request.method !== (roleEdit || trustEdit ? 'PUT' : 'GET')) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  const suggestions = url.pathname === SUGGESTIONS_ROUTE;
  const history = url.pathname === HISTORY_ROUTE;
  if (!modelBackends || (roleEdit && !roleSettings) || (trustEdit && !modelTrust) || (suggestions && !readRoleSuggestions)
    || (history && !settingsHistory)) {
    sendJson(response, 503, { error: 'Model backends need a local FULI installation' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  if (suggestions) {
    const limit = url.searchParams.get('limit');
    sendJson(response, 200, { suggestions: await readRoleSuggestions(limit === null ? {} : { limit: positiveInteger(Number(limit), 'limit', Number.MAX_SAFE_INTEGER) }),
      retention: RETENTION });
    return true;
  }
  if (history) {
    sendJson(response, 200, { entries: settingsHistory.list(historyQuery(url.searchParams)) });
    return true;
  }
  let saved = null;
  if (roleEdit) {
    if (refuseRemoteDecision(request, response, 'Model settings are changed only on this computer')) return true;
    saved = roleSettings.save(roleEdit, await readJson(request));
  }
  if (trustEdit) {
    if (refuseRemoteDecision(request, response, 'A role\'s execution mode is changed only on this computer')) return true;
    if (!Object.hasOwn(automaticOperations, trustEdit)) throw new TypeError(`${trustEdit} has no operation that runs by itself`);
    const parsed = TRUST_EDIT.safeParse(await readJson(request));
    if (!parsed.success) throw new TypeError('Send expectedRevision with either suggestionsOnly or acknowledgeWarning');
    const edit = parsed.data;
    saved = 'suggestionsOnly' in edit ? modelTrust.setSuggestionsOnly(trustEdit, edit.suggestionsOnly, edit.expectedRevision)
      : modelTrust.acknowledgeWarning(trustEdit, edit.acknowledgeWarning, edit.expectedRevision);
  }
  if (roleEdit || trustEdit || url.pathname === '/api/model-backends/roles') {
    const settings = modelBackends.roles();
    sendJson(response, 200, { ...settings, roles: settings.roles.map(role => ({ ...role,
      trust: trustView(role, settings.connections, { automaticOperations, modelTrust, readEvaluation }),
      localBuild: modelBackends.localBuild(role.role, role.connection?.id ?? null,
        role.connection ? settings.connections[role.connection.id] : null) })),
      operations, workPackages: roleWork?.summary().packages ?? [], ...(saved ? { history: saved.history } : {}) });
    return true;
  }
  sendJson(response, 200, modelBackends.usage({ role: url.searchParams.get('role'),
    from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  return true;
}

// One role at most, and a limit only as a plain decimal 1..MAX_HISTORY_LIMIT.
function historyQuery(params) {
  const [role = null, ...moreRoles] = params.getAll('role').map(value => value || null);
  if (moreRoles.length || (role !== null && !MODEL_BACKEND_ROLES.includes(role))) throw new TypeError('role must name one built-in Agent');
  const limits = params.getAll('limit');
  if (limits.length > 1 || (limits.length && !(/^[1-9][0-9]{0,2}$/.test(limits[0]) && Number(limits[0]) <= MAX_HISTORY_LIMIT))) {
    throw new TypeError(`limit must be a whole number from 1 to ${MAX_HISTORY_LIMIT}`);
  }
  return { role, ...(limits.length ? { limit: Number(limits[0]) } : {}) };
}

// rec#10 D-36, read-only: whether a role's model carries out its automatic
// operation by itself now, the person's 「只给建议」 choice and warning
// acknowledgement, and the latest local evaluation of the configured model.
// null for a role with no such operation: everything it does is a suggestion.
function trustView(role, connections, { automaticOperations, modelTrust, readEvaluation }) {
  const operation = automaticOperations[role.role];
  if (!operation || !modelTrust) return null;
  const served = role.answeredBy === 'model_api' ? connections[role.connection.id] : null;
  return { operation, ...modelTrust.view(role.role, operation), evaluation: served && readEvaluation
    ? readEvaluation({ role: role.role, operation, model: served.model, endpoint: served.endpoint }) : null };
}
