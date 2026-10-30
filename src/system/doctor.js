import { FULI_VERSION } from '../package-metadata.js';

// FULI's 体检 (doctor): whether this installation works and what needs fixing,
// read from what the console already observes. It only reads; the repair
// (doctor-repair.js) acts on the items marked fix 'auto'. The console's banner
// and the desktop client read the same answer (GET /api/system/doctor):
//
//   { checkedAt, version, overall, items: [{ id, kind, severity, fix, data }], unchecked, internal? }
//
// overall: 'degraded' when any item is blocking, else 'needs_person' when any
// is a warning, else 'ok'; info items never change it. unchecked names the
// sources that could not be read this time, so a missing item is never read
// as a healthy one. internal carries developer-facing comparisons that never
// change the items or overall (the client installer's shadow status, rec#11
// D-79); the console and desktop client do not show it.

// A client with FULI's integration left behind in an older or partial form.
const OUTDATED_CLIENT = new Set(['changed', 'skills_left']);
// Clients whose FULI integration a reconnection refreshes: `fuli setup --connected-only`.
const PRESENT_CLIENT = new Set(['connected', 'changed', 'skills_left']);
const SEVERITY_ORDER = Object.freeze({ blocking: 0, warning: 1, info: 2 });

// The clients a repair may reconnect: once connected, FULI's integration still
// present, and installable without the person (detected, not manual-only).
export function reconnectableClients(clients) {
  return clients.filter((client) => PRESENT_CLIENT.has(client.status) && client.previouslyConnected && canInstall(client));
}

const canInstall = (client) => client.detected && !client.manualOnly;

// observeClients: the client connection observation (client-connection-status.js).
// previewDataFormats: the data format plan (migration-plan.js), or null without a local installation.
// liveProcesses: live MCP server records (process-registry.js).
// latestVersion: the version checker's last answer without waiting, or null.
// lastUpdate: the console update journal's status (console-update.js), or null.
// internalDetails: returns the report's internal section without waiting, or null.
export function createDoctor({ observeClients, previewDataFormats = null, liveProcesses, latestVersion, lastUpdate,
  internalDetails = null, version = FULI_VERSION, now = () => new Date() }) {
  async function check() {
    const unchecked = [];
    const read = async (source, readSource) => {
      try { return await readSource(); } catch { unchecked.push(source); return null; }
    };
    const clients = await read('clients', observeClients);
    const formats = previewDataFormats ? await read('data_format', previewDataFormats) : null;
    const processes = await read('sessions', liveProcesses);
    const latest = await read('update', latestVersion);
    const update = await read('update', lastUpdate);
    const items = [
      ...clientItems(clients?.clients ?? []),
      ...dataFormatItems(formats),
      ...sessionItems(processes ?? [], version),
      ...updateItems(latest, update, version)
    ].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
    return { checkedAt: now().toISOString(), version, overall: overallOf(items), items, unchecked: [...new Set(unchecked)],
      ...(internalDetails ? { internal: internalDetails() } : {}) };
  }
  return { check };
}

function overallOf(items) {
  if (items.some((item) => item.severity === 'blocking')) return 'degraded';
  if (items.some((item) => item.severity === 'warning')) return 'needs_person';
  return 'ok';
}

const item = (id, kind, severity, fix, data) => ({ id, kind, severity, fix, data });

// A client the person connected before whose integration changed or lost its
// MCP entry. A client FULI cannot install by itself is the person's to reconnect.
function clientItems(clients) {
  return clients.filter((client) => OUTDATED_CLIENT.has(client.status) && client.previouslyConnected)
    .map((client) => item(`client_outdated:${client.id}`, 'client_outdated', 'warning', canInstall(client) ? 'auto' : 'person',
      { clientId: client.id, label: client.label, status: client.status }));
}

// Steps that wait for the person's confirmation, and stores FULI cannot use
// as they are. A graph whose provider does not answer is not a format
// finding: the plan says 'unavailable' and is left out.
function dataFormatItems(formats) {
  if (!formats) return [];
  const waiting = formats.stores.map((plan) => item(`data_format_waiting:${plan.label}`, 'data_format_waiting', 'blocking', 'person',
    { store: plan.store, label: plan.label, steps: [plan.step.id] }));
  const blocked = formats.blocked.filter((plan) => plan.action === 'blocked')
    .map((plan) => item(`data_format_blocked:${plan.label}`, 'data_format_blocked', 'blocking', 'person',
      { store: plan.store, label: plan.label, steps: plan.steps, reason: plan.reason }));
  return [...waiting, ...blocked];
}

// Open client sessions whose MCP server still runs another FULI version; only
// restarting those sessions loads the installed one.
function sessionItems(processes, version) {
  const groups = new Map();
  for (const record of processes.filter((candidate) => candidate.version !== version)) {
    const client = record.sourceApplication ?? 'other';
    const key = `${client}:${record.version}`;
    const group = groups.get(key) ?? { client, count: 0, runningVersion: record.version };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => item(`sessions_outdated:${key}`, 'sessions_outdated', 'warning', 'person', group));
}

function updateItems(latest, update, version) {
  const items = [];
  if (latest?.status === 'ready' && latest.updateAvailable) {
    items.push(item('update_available', 'update_available', 'info', 'person', { latest: latest.latestVersion }));
  }
  // The last console update installed this version but did not reconnect the
  // clients, or it failed and this is still the version it started from.
  if (update?.status === 'updated' && update.clients === 'not_reconnected' && update.version === version) {
    items.push(item('update_left_work', 'update_left_work', 'warning', 'auto',
      { updateId: update.id, status: 'updated', clients: 'not_reconnected', version: update.version }));
  } else if (update?.status === 'failed' && update.fromVersion === version) {
    items.push(item('update_left_work', 'update_left_work', 'warning', 'person',
      { updateId: update.id, status: 'failed', targetVersion: update.targetVersion, error: update.error }));
  }
  return items;
}
