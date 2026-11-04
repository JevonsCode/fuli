import { interfaceForRoute } from '../agent-tools/interface-catalog.js';
import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { callingTask } from '../app/calling-task.js';
import { requiredString } from '../validation/values.js';
import { verifiedPersonWords } from './person-words.js';
import { delegableEntry } from './refusals.js';

const ROUTE_LIMIT = 300;
const PARAM_LIMIT = 512;

// run_delegated_action (rec#11 D-81): an FLA makes one delegable console
// change for the person. Refused here before anything is sent when the
// catalog keeps the route for the person or names an Agent tool for it; the
// console then checks the person's AI permissions, runs the change and
// records it. Who made it comes from the calling task, never from arguments.
// A decision of the person's own (agent_relayed, rec#80) is sent only with
// their words, found in their recent messages of the calling task's session.
export const DELEGATION_HANDLERS = Object.freeze({
  run_delegated_action: async (app, input) => {
    const entry = delegableEntry(interfaceForRoute(requiredString(input?.route, 'route', ROUTE_LIMIT)));
    const reason = requiredString(input.reason, 'reason', 500);
    const body = input.body ?? {};
    const path = routePath(entry.route, input.params ?? {});
    const task = await callingTask(app, input);
    const relayed = entry.access === 'agent_relayed' ? await verifiedPersonWords(app, task, input.personWords) : null;
    const actor = { agentId: task.projectAgentId ?? null, projectId: task.personalProjectId ?? null,
      client: task.sourceApplication ?? null, sessionId: task.sessionId ?? null };
    const { result, operationId } = await delegatedConsole(app).send({ method: entry.route.split(' ')[0], path, body,
      call: { actor, reason, bodyFields: Object.keys(body), ...(relayed ? { relayed } : {}) } });
    return { status: 'done', route: entry.route, category: entry.category, operationId, undo: entry.undo, result,
      ...(relayed ? { relayed } : {}), delegation_receipt: { markdown: receipt(entry, operationId, relayed) } };
  }
});

function receipt(entry, operationId, relayed) {
  const record = `记录 ${operationId ?? '-'} · 撤销：${entry.undo}`;
  return relayed ? `🤝 已按你的原话记下你的决定：「${relayed.words}」（由我转达 · ${entry.route}）· ${record}`
    : `🤝 已代你操作 ${entry.route}（AI 权限 · ${entry.category}）· ${record}`;
}

function routePath(route, params) {
  const path = route.split(' ')[1];
  return path.split('/').map((part) => {
    if (!part.startsWith(':')) return part;
    const name = part.slice(1);
    const value = params[name];
    if (typeof value !== 'string' || !value || value.length > PARAM_LIMIT) {
      throw new InvalidInputError(`params.${name} is required for ${route}`);
    }
    return encodeURIComponent(value);
  }).join('/');
}

function delegatedConsole(app) {
  if (!app.delegatedConsole) {
    throw new ApplicationError('delegation_unavailable', 'AI permissions need a local FULI installation', { status: 503 });
  }
  return app.delegatedConsole;
}
