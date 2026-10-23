import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { positiveInteger } from '../validation/values.js';
import { RETENTION } from './suggestion-log.js';

// Routes of the model settings page. The roles and usage reads are
// Agent-readable and contain no secrets, but include metadata (endpoints,
// prices, approved projects); get_model_usage reads the same port. Saving one
// role is accepted only at the local process boundary (a loopback request).
// That does not show a person sent it and is not the human-review channel:
// no MCP or Agent tool calls it, but anything with local shell or HTTP access
// can. Keys stay a local command (fuli models set-key).
// operations: the task types each role already sends to its model.
// unlockedBuilds(modelId): the D-24 review gate registry's passing entries
// for that model (src/judgment/review-gate.js), read on every request.
// lastServed: the build that last answered each role on its configured model
// (its digest, or null when the backend did not prove one), read-only.
// suggestions lists what Astro, Bole and Jefa showed after asking their own
// model (suggestion-log.js), newest first, a limit clamped to RETENTION.rows, with
// its retention; it is a read only, and no route writes it.
const ROLE_ROUTE = /^\/api\/model-backends\/roles\/([a-z]+)$/;
const SUGGESTIONS_ROUTE = '/api/model-backends/suggestions';

export async function handleModelBackendApiRequest({
  request, response, url, modelBackends, roleWork = null, roleSuggestions = null, roleSettings = null, operations = {}, unlockedBuilds = null
}) {
  const roleEdit = ROLE_ROUTE.exec(url.pathname)?.[1] ?? null;
  if (!roleEdit && !['/api/model-backends/usage', '/api/model-backends/roles', SUGGESTIONS_ROUTE].includes(url.pathname)) return false;
  if (request.method !== (roleEdit ? 'PUT' : 'GET')) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  const suggestions = url.pathname === SUGGESTIONS_ROUTE;
  if (!modelBackends || (roleEdit && !roleSettings) || (suggestions && !roleSuggestions)) {
    sendJson(response, 503, { error: 'Model backends need a local FULI installation' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  if (suggestions) {
    const limit = url.searchParams.get('limit');
    sendJson(response, 200, { suggestions: roleSuggestions.list(limit === null ? {} : { limit: positiveInteger(Number(limit), 'limit', Number.MAX_SAFE_INTEGER) }),
      retention: RETENTION });
    return true;
  }
  if (roleEdit) {
    if (refuseRemoteDecision(request, response, 'Model settings are changed only on this computer')) return true;
    roleSettings.save(roleEdit, await readJson(request));
  }
  if (roleEdit || url.pathname === '/api/model-backends/roles') {
    const settings = modelBackends.roles();
    sendJson(response, 200, { ...settings, roles: settings.roles.map(role => ({ ...role, reviewGate: reviewGate(role, unlockedBuilds),
      lastServed: role.connection ? modelBackends.lastServed(role) : null })),
      operations, workPackages: roleWork?.summary().packages ?? [] });
    return true;
  }
  sendJson(response, 200, modelBackends.usage({ role: url.searchParams.get('role'),
    from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  return true;
}

// rec#10 D-24, read-only: whether a role's model may apply its result without
// the person. Only Tonborg's knowledge review has such a path, and only a
// model the role is answered by can be unlocked; everything else is a
// suggestion. A registry this FULI cannot read unlocks nothing.
function reviewGate(role, unlockedBuilds) {
  if (role.role !== 'tonborg') return { status: 'suggestion_only', reason: 'no_auto_apply', entries: [] };
  if (role.answeredBy !== 'model_api') return { status: 'suggestion_only', reason: 'no_model', entries: [] };
  const builds = unlockedBuilds ? unlockedBuilds(role.connection.model) : { readable: true, entries: [] };
  if (!builds.readable) return { status: 'suggestion_only', reason: 'registry_unreadable', entries: [] };
  return builds.entries.length ? { status: 'unlocked', reason: null, entries: builds.entries }
    : { status: 'suggestion_only', reason: 'no_entry', entries: [] };
}
