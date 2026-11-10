import { PERSONAL_GRAPH_LABEL } from '../data-format/format-status.js';
import { FULI_VERSION } from '../package-metadata.js';
import { LEGACY_MIGRATION_GUIDE_URL } from './graph-migration.js';

// FULI's 体检 (doctor): whether this installation works and what needs fixing,
// read from what the console already observes. It only reads; the repair
// (doctor-repair.js) acts on the items marked fix 'auto'. The console's banner
// and the desktop client read the same answer (GET /api/system/doctor):
//
//   { checkedAt, version, overall, items: [{ id, kind, severity, fix, data }], unchecked, uncheckedReasons }
//
// overall: 'degraded' when any item is blocking, else 'needs_person' when any
// is a warning, else 'ok'; info items never change it. unchecked names the
// sources that could not be read this time, so a missing item is never read
// as a healthy one; uncheckedReasons gives a reason code for each source that
// FULI knows why it could not check.

// A client with FULI's integration left behind in an older or partial form.
const OUTDATED_CLIENT = new Set(['changed', 'skills_left']);
// Clients whose FULI integration a reconnection refreshes: `fuli setup --connected-only`.
const PRESENT_CLIENT = new Set(['connected', 'changed', 'skills_left']);
const SEVERITY_ORDER = Object.freeze({ blocking: 0, warning: 1, info: 2 });
// Adaptive runtime stages in which the graph provider sleeps on purpose (runtime-broker.js).
const GRAPH_SLEEPING = new Set(['provider-sleeping', 'sleeping']);
// The sessions one outdated item names: what the console's offers request takes at once.
const MAX_OUTDATED_SESSIONS = 20;
// Too few transcript lines say nothing about a format; under half read means it changed.
const MIN_FORMAT_LINES = 5;
const MIN_RECOGNIZED_SHARE = 0.5;

// The clients a repair may reconnect: once connected, FULI's integration still
// present, and installable without the person (detected, not manual-only).
export function reconnectableClients(clients) {
  return clients.filter((client) => PRESENT_CLIENT.has(client.status) && client.previouslyConnected && canInstall(client));
}

// A client that writes its cached configuration back (rec#106) and is running, or may be, is the person's to quit and restart first.
const canInstall = (client) => client.detected && !client.manualOnly && !client.overwritten
  && !(client.restart && client.restart.running !== false);

// observeClients: the client connection observation (client-connection-status.js).
// previewDataFormats: the data format plan (migration-plan.js), or null without a local installation.
// formatOperations: the data directory's format operations log (operations-log.js).
// graphStage: the adaptive runtime's stage (runtime-broker.js), or null.
// liveProcesses: live MCP server records (process-registry.js).
// awaitingRestart: the open sessions that started before their client's last
// change (process-registry.js).
// latestVersion: the version checker's last answer without waiting, or null.
// lastUpdate: the console update journal's status (console-update.js), or null.
// hookTrust: whether each client's host trusts FULI's lifecycle hooks, read by
//   that client's own reader (src/agents/<client>/hook-trust-reader.js): an
//   async function returning { [clientId]: { readable: true, untrusted: [eventName...] }
//   | { readable: false, reason } }. A readable client with untrusted hooks is a
//   warning; an unreadable one stays in unchecked, never guessed healthy.
// transcriptFormat: how much of each client's newest private transcript FULI's
//   parser still reads, by that client's own probe
//   (src/agents/transcript-format-registry.js): an async function returning
//   { [clientId]: { readable: true, recognized, total } | { readable: false, reason } }.
//   A connected client whose parser reads under half of at least five lines
//   changed its format; an unreadable one stays in unchecked.
// portMoves: the ports the running console's start moved by itself
// ({ movedAt, moves }, blocked-port-recovery.js), or null.
// graphRuntime: { mode, migration } — the active graph runtime mode and the
// last one-click migration (graph-migration.js), or null.
// dataDirShared: the principals besides the person and SYSTEM that the data
// directory's ACL lets in (windows-data-acl.js); none outside Windows.
// runningServers: this installation's MCP servers the OS shows running
// ([{ pid, parentPid, startedAt }], mcp-process-scan.js), or null when the
// list could not be read.
// npmCopies: the npm installations of FULI beside the desktop app's own
// (src/desktop/npm-copies.js); none when this console is not the app's.
export function createDoctor({ observeClients, previewDataFormats = null, formatOperations = () => [],
  graphStage = () => null, liveProcesses, awaitingRestart = () => [], latestVersion, lastUpdate, hookTrust = async () => ({}),
  transcriptFormat = async () => ({}),
  portMoves = () => null, graphRuntime = () => null, dataDirShared = async () => [], runningServers = () => [],
  npmCopies = () => [], version = FULI_VERSION, now = () => new Date() }) {
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
    // Clients are read through agent-installer (client-detection.js); without it nothing is known.
    if (clients?.available === false) notChecked('clients', 'client_detection_unavailable');
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
    const trust = await read('hook_trust', hookTrust) ?? {};
    const untrustedHooks = [];
    for (const client of (clients?.clients ?? []).filter((candidate) => PRESENT_CLIENT.has(candidate.status))) {
      const result = trust[client.id];
      if (!result) continue;
      if (result.readable !== true) notChecked(`hook_trust:${client.id}`, result.reason);
      else if (Array.isArray(result.untrusted) && result.untrusted.length) {
        untrustedHooks.push(hookTrustUntrustedItem(client, result.untrusted));
      }
    }
    const formatsRead = await read('transcript_format', transcriptFormat) ?? {};
    const changedFormats = [];
    for (const client of (clients?.clients ?? []).filter((candidate) => candidate.status === 'connected')) {
      const result = formatsRead[client.id];
      if (!result) continue;
      if (result.readable !== true) notChecked(`transcript_format:${client.id}`, result.reason);
      else if (result.total >= MIN_FORMAT_LINES && result.recognized / result.total < MIN_RECOGNIZED_SHARE) {
        changedFormats.push(item(`client_format_changed:${client.id}`, 'client_format_changed', 'warning', 'person',
          { clientId: client.id, label: client.label, recognized: result.recognized, total: result.total }));
      }
    }
    const processes = await read('sessions', liveProcesses);
    const running = await read('sessions', runningServers);
    // A list that could not be read says nothing about unrecorded servers.
    if (running === null) notChecked('sessions', 'process_list_unavailable');
    const waiting = await read('sessions', awaitingRestart);
    const latest = await read('update', latestVersion);
    const update = await read('update', lastUpdate);
    const moved = await read('runtime', portMoves);
    const runtime = await read('runtime', graphRuntime);
    const shared = await read('data_dir', dataDirShared);
    const copies = await read('install', npmCopies);
    const items = [
      ...graphRuntimeItems(runtime),
      ...clientItems(clients?.clients ?? []),
      ...untrustedHooks,
      ...changedFormats,
      ...dataFormatItems(formats),
      ...rememberedGraph,
      ...sessionItems(processes ?? [], version),
      ...unrecordedItems(processes && running ? unrecordedServers(running, processes) : []),
      ...restartItems(waiting ?? []),
      ...updateItems(latest, update, version),
      ...portItems(moved),
      ...dataDirItems(shared),
      ...npmCopyItems(copies)
    ].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
    return { checkedAt, version, overall: overallOf(items), items, unchecked: [...new Set(unchecked)], uncheckedReasons };
  }
  return { check };
}

function overallOf(items) {
  if (items.some((item) => item.severity === 'blocking')) return 'degraded';
  if (items.some((item) => item.severity === 'warning')) return 'needs_person';
  return 'ok';
}

const item = (id, kind, severity, fix, data) => ({ id, kind, severity, fix, data });

// An install from before the built-in graph still keeps its knowledge in a
// Docker (container) graph. Newer FULI only grows on the built-in one, so the
// person moves it once: one click in Settings, or the external guide an AI
// can follow when the click cannot finish (graph-migration.js).
function graphRuntimeItems(runtime) {
  if (runtime?.mode !== 'container') return [];
  const migration = runtime.migration;
  return [item('graph_container', 'graph_container', 'warning', 'person', {
    migration: migration ? { status: migration.status, error: migration.error ?? null,
      finishedAt: migration.finishedAt ?? null } : null,
    guideUrl: LEGACY_MIGRATION_GUIDE_URL
  })];
}

// A client the person connected before whose integration changed or lost its
// MCP entry. A client FULI cannot install by itself is the person's to reconnect.
// since: when the client's connection history first saw this state.
function clientItems(clients) {
  return clients.filter((client) => OUTDATED_CLIENT.has(client.status) && client.previouslyConnected)
    .map((client) => item(`client_outdated:${client.id}`, 'client_outdated', 'warning', canInstall(client) ? 'auto' : 'person',
      { clientId: client.id, label: client.label, status: client.status, ...(client.since ? { since: client.since } : {}) }));
}

// A client whose host does not trust FULI's lifecycle hooks: the person opens
// that client's own hook review and trusts them there. One item per client,
// naming the untrusted events.
function hookTrustUntrustedItem(client, untrusted) {
  return item(`hook_trust_untrusted:${client.id}`, 'hook_trust_untrusted', 'warning', 'person',
    { clientId: client.id, label: client.label, untrusted });
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
// restarting those sessions loads the installed one. sessions names the ones
// the servers answered calls for, so the console can offer to open them; a
// server that answered none still counts. since: when the oldest of those
// servers started, so the person sees how long they have run the older FULI.
function sessionItems(processes, version) {
  const groups = new Map();
  for (const record of processes.filter((candidate) => candidate.version !== version)) {
    const client = record.sourceApplication ?? 'other';
    const key = `${client}:${record.version}`;
    const group = groups.get(key) ?? { client, count: 0, runningVersion: record.version, since: null, sessions: new Map() };
    group.count += 1;
    if (typeof record.startedAt === 'string' && (!group.since || record.startedAt < group.since)) group.since = record.startedAt;
    if (record.sourceApplication) {
      for (const sessionId of Array.isArray(record.sessionIds) ? record.sessionIds : []) {
        if (typeof sessionId === 'string') group.sessions.set(sessionId, { sourceApplication: client, sessionId });
      }
    }
    groups.set(key, group);
  }
  return [...groups].map(([key, { sessions, since, ...group }]) => item(`sessions_outdated:${key}`, 'sessions_outdated', 'warning', 'person',
    { ...group, ...(since ? { since } : {}), sessions: [...sessions.values()].slice(0, MAX_OUTDATED_SESSIONS) }));
}

// Running servers a FULI older than process-registry.js started: they write no
// record, so neither their client nor their version is known. A process that
// is the parent of another listed one is not a session's server of its own:
// a relay (stdio-relay.js) or FuliNode.exe runs the same command line as the
// server under it, and that server is recorded or counted itself.
function unrecordedServers(running, records) {
  const recorded = new Set(records.map(({ pid }) => pid));
  const parents = new Set(running.map(({ parentPid }) => parentPid));
  return running.filter(({ pid }) => !recorded.has(pid) && !parents.has(pid));
}

function unrecordedItems(servers) {
  if (!servers.length) return [];
  const since = servers.map(({ startedAt }) => startedAt).filter((startedAt) => typeof startedAt === 'string').sort()[0];
  return [item('sessions_outdated:other:unknown', 'sessions_outdated', 'warning', 'person',
    { client: 'other', count: servers.length, runningVersion: null, ...(since ? { since } : {}), sessions: [] })];
}

// Open sessions that started before FULI changed their client's Skills or hooks:
// only a restart loads them, and starting one clears this by itself.
function restartItems(waiting) {
  return waiting.map(({ sourceApplication, count, changedAt, sessions }) => item(`client_restart:${sourceApplication}`, 'client_restart', 'warning', 'person',
    { client: sourceApplication, count, since: changedAt,
      sessions: sessions.slice(0, MAX_OUTDATED_SESSIONS).map(sessionId => ({ sourceApplication, sessionId })) }));
}

// Ports this console's start moved because Windows reserved them or another
// program held them. Nothing is left to do; the id names the start, so a
// client says it once per move.
function portItems(moved) {
  if (!moved?.moves?.length) return [];
  return [item(`ports_moved:${moved.movedAt}`, 'ports_moved', 'info', 'person', moved)];
}

// On Windows the data directory, with the human-review token and every
// store, is open to other accounts or sandboxes (rec#53). The repair limits
// it to the person and SYSTEM; principals are SIDs or SDDL aliases.
function dataDirItems(shared) {
  if (!shared?.length) return [];
  return [item('data_dir_shared', 'data_dir_shared', 'warning', 'auto', { principals: shared })];
}

// FULI installed with npm before the desktop app: the app now runs the
// shared data and every connected client, and the person removes the npm
// copy when they choose (one command each). shellCommands: the bare
// commands a terminal still answers with that copy, since the app's own
// CLI is not on PATH.
function npmCopyItems(copies) {
  if (!copies?.length) return [];
  return [item('npm_copy_installed', 'npm_copy_installed', 'info', 'person', {
    copies: copies.map(({ version, shellCommands }) => ({ version, shellCommands })),
    commands: copies.map(({ removeCommand }) => removeCommand)
  })];
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
