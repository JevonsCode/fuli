import { z } from 'zod';

import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { positiveInteger } from '../validation/values.js';
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
// its retention; it is a read only, and no route writes it.
const ROLE_ROUTE = /^\/api\/model-backends\/roles\/([a-z]+)$/;
const TRUST_ROUTE = /^\/api\/model-backends\/roles\/([a-z]+)\/trust$/;
const SUGGESTIONS_ROUTE = '/api/model-backends/suggestions';
const revision = z.number().int().min(0);
const TRUST_EDIT = z.union([
  z.object({ expectedRevision: revision, suggestionsOnly: z.boolean() }).strict(),
  z.object({ expectedRevision: revision, acknowledgeWarning: z.number().int().min(1) }).strict()
]);

export async function handleModelBackendApiRequest({
  request, response, url, modelBackends, roleWork = null, readRoleSuggestions = null, roleSettings = null, operations = {},
  automaticOperations = {}, modelTrust = null, readEvaluation = null
}) {
  const roleEdit = ROLE_ROUTE.exec(url.pathname)?.[1] ?? null;
  const trustEdit = TRUST_ROUTE.exec(url.pathname)?.[1] ?? null;
  if (!roleEdit && !trustEdit && !['/api/model-backends/usage', '/api/model-backends/roles', SUGGESTIONS_ROUTE].includes(url.pathname)) return false;
  if (request.method !== (roleEdit || trustEdit ? 'PUT' : 'GET')) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  const suggestions = url.pathname === SUGGESTIONS_ROUTE;
  if (!modelBackends || (roleEdit && !roleSettings) || (trustEdit && !modelTrust) || (suggestions && !readRoleSuggestions)) {
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
  if (roleEdit) {
    if (refuseRemoteDecision(request, response, 'Model settings are changed only on this computer')) return true;
    roleSettings.save(roleEdit, await readJson(request));
  }
  if (trustEdit) {
    if (refuseRemoteDecision(request, response, 'A role\'s execution mode is changed only on this computer')) return true;
    if (!Object.hasOwn(automaticOperations, trustEdit)) throw new TypeError(`${trustEdit} has no operation that runs by itself`);
    const parsed = TRUST_EDIT.safeParse(await readJson(request));
    if (!parsed.success) throw new TypeError('Send expectedRevision with either suggestionsOnly or acknowledgeWarning');
    const edit = parsed.data;
    if ('suggestionsOnly' in edit) modelTrust.setSuggestionsOnly(trustEdit, edit.suggestionsOnly, edit.expectedRevision);
    else modelTrust.acknowledgeWarning(trustEdit, edit.acknowledgeWarning, edit.expectedRevision);
  }
  if (roleEdit || trustEdit || url.pathname === '/api/model-backends/roles') {
    const settings = modelBackends.roles();
    sendJson(response, 200, { ...settings, roles: settings.roles.map(role => ({ ...role,
      trust: trustView(role, { automaticOperations, modelTrust, readEvaluation }),
      localBuild: modelBackends.localBuild(role.role, role.connection?.id ?? null,
        role.connection ? settings.connections[role.connection.id] : null) })),
      operations, workPackages: roleWork?.summary().packages ?? [] });
    return true;
  }
  sendJson(response, 200, modelBackends.usage({ role: url.searchParams.get('role'),
    from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  return true;
}

// rec#10 D-36, read-only: whether a role's model carries out its automatic
// operation by itself now, the person's 「只给建议」 choice and warning
// acknowledgement, and the latest local evaluation of the configured model.
// null for a role with no such operation: everything it does is a suggestion.
function trustView(role, { automaticOperations, modelTrust, readEvaluation }) {
  const operation = automaticOperations[role.role];
  if (!operation || !modelTrust) return null;
  const model = role.answeredBy === 'model_api' ? role.connection.model : null;
  return { operation, ...modelTrust.view(role.role, operation),
    evaluation: model && readEvaluation ? readEvaluation({ role: role.role, operation, model }) : null };
}
