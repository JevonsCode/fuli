import { readFileSync } from 'node:fs';

import { detectClients } from '../agent-kits/client-detection.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// Kept per client so a long-lived console cannot grow this file without bound.
const MAX_CHANGES = 5;
export const CLIENT_CONNECTION_HISTORY_FORMAT = jsonFormat({ store: 'client-connection-history', versions: [1] });
// Statuses that prove a FULI entry was present in the client's configuration.
const PRESENT = new Set(['connected', 'changed']);
// Statuses an observation can persist; "unknown" is never stored as fact.
const STATUSES = new Set(['connected', 'changed', 'skills_left', 'removed', 'not_connected', 'not_detected']);
// Component states that leave FULI's files in a client.
const LEFT = new Set(['current', 'outdated', 'conflict']);

/**
 * Observe which agent clients are on this machine and whether FULI is in
 * them, as agent-installer reads their configuration (client-detection.js).
 * This reads configuration only: it never proves a client is running or
 * that its MCP session is reachable, and it never reinstalls.
 *
 * installer: the client installer port. targets: FULI's writer targets
 * (agentTargets): a built-in client without one is the person's to connect.
 * customClients: the custom client store (custom-clients.js).
 */
export function createClientConnectionObserver({ installer, targets, customClients, historyPath, now = () => new Date() }) {
  // History that could not be written stays reliable for this observer.
  let retained = null;

  async function observe() {
    const observedAt = now().toISOString();
    const answer = await detectClients(installer);
    if (answer.status !== 'available') {
      return { scope: 'configuration', observedAt, available: false, historySaved: true, clients: [], customClients: [] };
    }
    const writers = new Map(targets().map((target) => [target.id, target]));
    const builtin = answer.clients.filter((client) => client.builtin);
    const history = sanitizeHistory(retained ?? readHistory(historyPath), builtin.map(({ id }) => id));
    let dirty = retained !== null;
    const clients = builtin.map((client) => {
      const writer = writers.get(client.id);
      const extra = { manualOnly: client.manual || !writer || Boolean(writer.manualOnly),
        ...(writer?.manualUrl ? { manualUrl: writer.manualUrl } : {}) };
      const record = history.clients[client.id] ?? { status: null, previouslyConnected: false, since: null, changes: [] };
      // A FULI entry FULI cannot read or call its own is never reported as a removal.
      if (client.components.mcp === 'conflict') {
        return view(client, { ...record, status: 'unknown' }, { ...extra, lastKnownStatus: record.status });
      }
      const previouslyConnected = record.previouslyConnected || PRESENT.has(statusOf(client, false));
      const status = statusOf(client, previouslyConnected);
      if (status !== record.status || previouslyConnected !== record.previouslyConnected) {
        const changes = record.status && status !== record.status
          ? [...record.changes, { from: record.status, to: status, detectedAt: observedAt }].slice(-MAX_CHANGES)
          : record.changes;
        history.clients[client.id] = { status, previouslyConnected,
          since: status === record.status ? record.since : observedAt, changes };
        dirty = true;
      }
      return view(client, history.clients[client.id] ?? record, { ...extra, components: client.components });
    });
    let historySaved = true;
    if (dirty) {
      try {
        writeVersionedJsonFileAtomic(historyPath, history, CLIENT_CONNECTION_HISTORY_FORMAT);
        retained = null;
      } catch { retained = history; historySaved = false; }
    }
    const removable = customClients.removable();
    return { scope: 'configuration', observedAt, available: true, historySaved, clients,
      customClients: answer.clients.filter((client) => !client.builtin).map((client) => ({
        id: client.id, label: client.label, detected: client.detected,
        status: client.components.mcp === 'conflict' ? 'unknown' : statusOf(client, false),
        // Where the person puts FULI's MCP entry by hand, relative to home.
        mcpPaths: client.mcpPaths, removable: removable.has(client.id) })) };
  }
  return { observe };
}

function statusOf(client, previouslyConnected) {
  const { mcp, skills } = client.components;
  if (client.connected) return 'connected';
  if (LEFT.has(mcp)) return 'changed';
  if (LEFT.has(skills)) return 'skills_left';
  if (previouslyConnected) return 'removed';
  return client.detected ? 'not_connected' : 'not_detected';
}

// Only bounded, path-free fields leave this module.
function view(client, record, extra) {
  return { id: client.id, label: client.label, detected: client.detected,
    status: record.status, previouslyConnected: record.previouslyConnected,
    since: record.since, changes: record.changes, ...extra };
}

function readHistory(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch {
    // Absent or corrupt history starts fresh; it cannot prove a past connection.
    return null;
  }
}

// Rebuild history from allowed fields only; anything unrecognized is dropped.
function sanitizeHistory(value, ids) {
  const clients = {};
  const stored = value?.version === 1 && isObject(value.clients) ? value.clients : {};
  for (const id of ids) {
    if (!Object.hasOwn(stored, id)) continue;
    const record = sanitizeRecord(stored[id]);
    if (record) clients[id] = record;
  }
  return { version: 1, clients };
}

function sanitizeRecord(record) {
  if (!isObject(record) || !STATUSES.has(record.status)) return null;
  const previouslyConnected = record.previouslyConnected === true;
  // A removal is only meaningful after an observed connection.
  if (record.status === 'removed' && !previouslyConnected) return null;
  const changes = Array.isArray(record.changes)
    ? record.changes.slice(-MAX_CHANGES)
      .filter((change) => isObject(change) && STATUSES.has(change.from) && STATUSES.has(change.to)
        && isTimestamp(change.detectedAt))
      .map(({ from, to, detectedAt }) => ({ from, to, detectedAt }))
    : [];
  return { status: record.status, previouslyConnected,
    since: isTimestamp(record.since) ? record.since : null, changes };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
