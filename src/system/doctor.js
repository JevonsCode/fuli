import { PERSONAL_GRAPH_LABEL } from '../data-format/format-status.js';
import { FULI_VERSION } from '../package-metadata.js';

// FULI's 体检 (doctor): whether this installation works and what needs fixing,
// read from what the console already observes. It only reads; the repair
// (doctor-repair.js) acts on the items marked fix 'auto'. The console's banner
// and the desktop client read the same answer (GET /api/system/doctor):
//
//   { checkedAt, version, overall, items: [{ id, kind, severity, fix, data }], unchecked, uncheckedReasons, internal? }
//
// overall: 'degraded' when any item is blocking, else 'needs_person' when any
// is a warning, else 'ok'; info items never change it. unchecked names the
// sources that could not be read this time, so a missing item is never read
// as a healthy one; uncheckedReasons gives a reason code for each source that
// FULI knows why it could not check. internal carries developer-facing
// comparisons that never change the items or overall (the client installer's
// shadow status, rec#11 D-79); the console and desktop client do not show it.

// A client with FULI's integration left behind in an older or partial form.
const OUTDATED_CLIENT = new Set(['changed', 'skills_left']);
// Clients whose FULI integration a reconnection refreshes: `fuli setup --connected-only`.
const PRESENT_CLIENT = new Set(['connected', 'changed', 'skills_left']);
const SEVERITY_ORDER = Object.freeze({ blocking: 0, warning: 1, info: 2 });
// Adaptive runtime stages in which the graph provider sleeps on purpose (runtime-broker.js).
const GRAPH_SLEEPING = new Set(['provider-sleeping', 'sleeping']);

// The clients a repair may reconnect: once connected, FULI's integration still
// present, and installable without the person (detected, not manual-only).
export function reconnectableClients(clients) {
  return clients.filter((client) => PRESENT_CLIENT.has(client.status) && client.previouslyConnected && canInstall(client));
}

const canInstall = (client) => client.detected && !client.manualOnly;

// observeClients: the client connection observation (client-connection-status.js).
// previewDataFormats: the data format plan (migration-plan.js), or null without a local installation.
// formatOperations: the data directory's format operations log (operations-log.js).
// graphStage: the adaptive runtime's stage (runtime-broker.js), or null.
// liveProcesses: live MCP server records (process-registry.js).
// latestVersion: the version checker's last answer without waiting, or null.
// lastUpdate: the console update journal's status (console-update.js), or null.
// hookTrustUnreadable: IDs of clients whose host keeps its trust in FULI's
//   hooks where FULI cannot read it (src/agents/<client>/hook-trust.js).
// internalDetails: returns the report's internal section without waiting, or null.
// portMoves: the ports the running console's start moved by itself
// ({ movedAt, moves }, blocked-port-recovery.js), or null.
export function createDoctor({ observeClients, previewDataFormats = null, formatOperations = () => [],
  graphStage = () => null, liveProcesses, latestVersion, lastUpdate, hookTrustUnreadable = [],
  internalDetails = null, portMoves = () => null, version = FULI_VERSION, now = () => new Date() }) {
  // The personal graph's last answer while its provider answered: the step it
  // waited on, or null, and when that was seen.
  let lastGraph = null;

  async function check() {
    const checkedAt = now().toISOString();
    const unchecked = [];
    const uncheckedReasons = {};
    const notChecked = (source, reason) => { unchecked.push(source); uncheckedReasons[source] = reason; };
    const read = async (source, readSource) => {
      try { return await readSource(); } catch { unchecked.push(source); return null; }
    };
    const clients = await read('clients', observeClients);
    const formats = previewDataFormats ? await read('data_format', previewDataFormats) : null;
    let rememberedGraph = [];
    if (formats) {
      const graph = graphAnswer(formats);
      if (graph.answered) {
        lastGraph = { waiting: graph.waiting, seenAt: checkedAt };
      } else {
        const stage = await read('graph_format', graphStage);
        notChecked('graph_format', GRAPH_SLEEPING.has(stage) ? 'graph_sleeping' : 'graph_not_answering');
        lastGraph = await stillWaiting(lastGraph, () => read('graph_format', formatOperations));
        if (lastGraph?.waiting) rememberedGraph = [waitingItem(lastGraph.waiting, { lastSeenAt: lastGraph.seenAt })];
      }
    }
    for (const client of (clients?.clients ?? []).filter((candidate) =>
      hookTrustUnreadable.includes(candidate.id) && PRESENT_CLIENT.has(candidate.status))) {
      notChecked(`hook_trust:${client.id}`, 'host_trust_unreadable');
    }
    const processes = await read('sessions', liveProcesses);
    const latest = await read('update', latestVersion);
    const update = await read('update', lastUpdate);
    const moved = await read('runtime', portMoves);
    const items = [
      ...clientItems(clients?.clients ?? []),
      ...dataFormatItems(formats),
      ...rememberedGraph,
      ...sessionItems(processes ?? [], version),
      ...updateItems(latest, update, version),
      ...portItems(moved)
    ].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
    return { checkedAt, version, overall: overallOf(items), items, unchecked: [...new Set(unchecked)], uncheckedReasons,
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
// as they are. A graph whose provider does not answer is no finding of its
// own: the plan says 'unavailable', and the graph is reported unchecked.
function dataFormatItems(formats) {
  if (!formats) return [];
  const waiting = formats.stores.map((plan) => waitingItem(plan));
  const blocked = formats.blocked.filter((plan) => plan.action === 'blocked')
    .map((plan) => item(`data_format_blocked:${plan.label}`, 'data_format_blocked', 'blocking', 'person',
      { store: plan.store, label: plan.label, steps: plan.steps, reason: plan.reason }));
  return [...waiting, ...blocked];
}

const waitingItem = (plan, extra = {}) => item(`data_format_waiting:${plan.label}`, 'data_format_waiting', 'blocking',
  'person', { store: plan.store, label: plan.label, steps: [plan.step.id], ...extra });

// The personal graph's part of the plan: whether its provider answered, and
// the step it waits on for a confirmation, or null.
function graphAnswer(formats) {
  if (formats.blocked.some((plan) => plan.label === PERSONAL_GRAPH_LABEL && plan.action === 'unavailable')) {
    return { answered: false };
  }
  return { answered: true, waiting: formats.stores.find((plan) => plan.label === PERSONAL_GRAPH_LABEL) ?? null };
}

// The graph keeps its format inside Neo4j, so only its provider can say it.
// A step it waited on stays a finding while the provider sleeps: until the
// person confirms it, every FULI write to the graph fails with
// data_format_read_only. A graph migration applied, undone or restored since
// it was seen (format-operations.json, which the console and `fuli migrate`
// write) makes that answer stale; it is dropped and the graph stays unchecked.
async function stillWaiting(lastGraph, readOperations) {
  if (!lastGraph?.waiting) return lastGraph;
  const operations = await readOperations();
  if (!operations) return null;
  const seenAt = Date.parse(lastGraph.seenAt);
  return operations.some((event) => event.label === PERSONAL_GRAPH_LABEL && Date.parse(event.at) >= seenAt)
    ? null : lastGraph;
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

// Ports this console's start moved because Windows reserved them or another
// program held them. Nothing is left to do; the id names the start, so a
// client says it once per move.
function portItems(moved) {
  if (!moved?.moves?.length) return [];
  return [item(`ports_moved:${moved.movedAt}`, 'ports_moved', 'info', 'person', moved)];
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
