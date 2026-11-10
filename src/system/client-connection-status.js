import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';

import { clientSourceApplication, detectClients } from '../agent-kits/client-detection.js';
import { configuredInstall, installOf } from '../agent-kits/configured-install.js';
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
// Where a client agent-installer leaves to the person documents its configuration.
const MANUAL_URLS = Object.freeze({ opencode: 'https://opencode.ai/docs/config/' });
// A client that writes back the FULI entry it had before an update does so
// when it next saves its own settings: minutes to an hour later (rec#106).
const OVERWRITE_WINDOW_MS = 2 * 60 * 60_000;
// An installation path kept in history is bounded like any other stored field.
const MAX_INSTALL_KEY = 1024;

/**
 * Observe which agent clients are on this machine and whether FULI is in
 * them, as agent-installer reads their configuration (client-detection.js).
 * This reads configuration only: it never proves a client is running or
 * that its MCP session is reachable, and it never reinstalls.
 *
 * installer: the client installer port. customClients: the custom client
 * store (custom-clients.js). awaitingRestart: the open sessions that started
 * before their client's last change (process-registry.js). consoleInstall:
 * the command line this console writes into clients ({ nodePath,
 * mcpServerPath, version }). apps: the client apps FULI can restart
 * (src/agents/client-apps.js), asked whether they run only while their entry
 * needs an update.
 *
 * A client whose entry FULI updated and which then, within
 * OVERWRITE_WINDOW_MS, names again the very installation that update
 * replaced was overwritten by that client, not by a newer FULI: that change
 * says `overwritten` (rec#106).
 */
export function createClientConnectionObserver({ installer, customClients, historyPath, now = () => new Date(), awaitingRestart = () => [],
  consoleInstall = null, apps = {}, homeDir = homedir(), platform = process.platform }) {
  const own = consoleInstall ? installOf([consoleInstall.nodePath, consoleInstall.mcpServerPath], { platform }) : null;
  const ownInstall = own ? { path: displayPath(own.root, homeDir, platform), version: consoleInstall.version } : null;
  // History that could not be written stays reliable for this observer.
  let retained = null;

  async function observe() {
    const observedAt = now().toISOString();
    const answer = await detectClients(installer);
    if (answer.status !== 'available') {
      return { scope: 'configuration', observedAt, available: false, historySaved: true, clients: [], customClients: [] };
    }
    const builtin = answer.clients.filter((client) => client.builtin);
    const waiting = new Map(awaitingRestart().map(entry => [entry.sourceApplication, entry.count]));
    const history = sanitizeHistory(retained ?? readHistory(historyPath), builtin.map(({ id }) => id));
    let dirty = retained !== null;
    const clients = builtin.map((client) => {
      // sourceApplication: the client as FULI's other records name it (client links, capture), so a reader needs no mapping of its own.
      const sourceApplication = clientSourceApplication(client.id);
      const extra = { sourceApplication, manualOnly: client.manual, restartSessions: waiting.get(sourceApplication) ?? 0,
        ...(client.manual && MANUAL_URLS[client.id] ? { manualUrl: MANUAL_URLS[client.id] } : {}) };
      const record = history.clients[client.id] ?? { status: null, previouslyConnected: false, since: null, changes: [] };
      // A FULI entry FULI cannot read or call its own is never reported as a removal.
      if (client.components.mcp === 'conflict') {
        return { shown: view(client, { ...record, status: 'unknown' }, { ...extra, lastKnownStatus: record.status }) };
      }
      const previouslyConnected = record.previouslyConnected || PRESENT.has(statusOf(client, false));
      const status = statusOf(client, previouslyConnected);
      // Only an entry that differs from this console's is read for what it names.
      const configured = status === 'changed' ? configuredInstall(client.mcpPaths, { homeDir, platform }) : null;
      // Only another installation can be written back: an entry naming the console's own (its Skills or hooks
      // outdated, or a FULI that upgrades in place) is an ordinary update.
      const foreign = configured && configured.key !== own?.key && configured.key.length <= MAX_INSTALL_KEY ? configured.key : null;
      const replacedInstall = foreign ?? record.replacedInstall;
      if (status !== record.status || previouslyConnected !== record.previouslyConnected || replacedInstall !== record.replacedInstall) {
        const change = { from: record.status, to: status, detectedAt: observedAt,
          ...(overwrittenBy(record, status, foreign, observedAt) ? { overwritten: true } : {}) };
        const changes = record.status && status !== record.status ? [...record.changes, change].slice(-MAX_CHANGES) : record.changes;
        history.clients[client.id] = { status, previouslyConnected,
          since: status === record.status ? record.since : observedAt, changes, ...(replacedInstall ? { replacedInstall } : {}) };
        dirty = true;
      }
      return { client, record: history.clients[client.id] ?? record, configured, extra };
    });
    const views = await Promise.all(clients.map(async ({ shown, client, record, configured, extra }) => {
      if (shown) return shown;
      const app = record.status === 'changed' ? apps[client.id] : null;
      const running = app ? await app.running().catch(() => null) : null;
      return view(client, record, { ...extra, components: client.components,
        ...(configured ? { configuredInstall: { path: displayPath(configured.root, homeDir, platform), version: configured.version,
          exists: configured.exists, sameAsConsole: configured.key === own?.key } } : {}),
        ...(app ? { restart: { running } } : {}) });
    }));
    let historySaved = true;
    if (dirty) {
      try {
        writeVersionedJsonFileAtomic(historyPath, history, CLIENT_CONNECTION_HISTORY_FORMAT);
        retained = null;
      } catch { retained = history; historySaved = false; }
    }
    const removable = customClients.removable();
    return { scope: 'configuration', observedAt, available: true, historySaved, clients: views,
      ...(ownInstall ? { installs: installsOf(ownInstall, views, platform) } : {}),
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

// Whether this change back to an outdated entry restores what the last update replaced, soon after it.
function overwrittenBy(record, status, foreignKey, observedAt) {
  const updated = record.changes.at(-1);
  return status === 'changed' && record.status === 'connected' && Boolean(foreignKey) && foreignKey === record.replacedInstall
    && updated?.to === 'connected' && Date.parse(observedAt) - Date.parse(updated.detectedAt) <= OVERWRITE_WINDOW_MS;
}

// The console's installation and every other one a client entry names (rec#106: two FULIs on one machine).
function installsOf(own, views, platform) {
  const others = new Map();
  for (const client of views) {
    const install = client.configuredInstall;
    if (!install || install.sameAsConsole || !install.exists) continue;
    const key = platform === 'win32' ? install.path.toLowerCase() : install.path;
    const entry = others.get(key) ?? { path: install.path, version: install.version, clients: [] };
    entry.clients.push(client.label);
    others.set(key, entry);
  }
  return { console: own, others: [...others.values()] };
}

// Home shown as ~ (case-insensitive on Windows), and on macOS an app bundle by its .app folder.
function displayPath(root, homeDir, platform) {
  const home = homeDir.endsWith(sep) ? homeDir.slice(0, -1) : homeDir;
  const fold = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const inHome = fold(root) === fold(home) || fold(root).startsWith(fold(home) + sep);
  const shown = inHome ? `~${root.slice(home.length)}` : root;
  return platform === 'darwin' ? /^(.*?\.app)(?=[\\/]|$)/.exec(shown)?.[1] ?? shown : shown;
}

// Bounded fields leave this module; the only paths are FULI's own installations, home shown as ~.
function view(client, record, extra) {
  return { id: client.id, label: client.label, detected: client.detected,
    status: record.status, previouslyConnected: record.previouslyConnected,
    since: record.since, changes: record.changes, overwritten: record.status === 'changed' && record.changes.at(-1)?.overwritten === true,
    ...extra };
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
      .map(({ from, to, detectedAt, overwritten }) => ({ from, to, detectedAt, ...(overwritten === true ? { overwritten } : {}) }))
    : [];
  const replacedInstall = typeof record.replacedInstall === 'string' && record.replacedInstall.length <= MAX_INSTALL_KEY
    ? record.replacedInstall : null;
  return { status: record.status, previouslyConnected,
    since: isTimestamp(record.since) ? record.since : null, changes, ...(replacedInstall ? { replacedInstall } : {}) };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
