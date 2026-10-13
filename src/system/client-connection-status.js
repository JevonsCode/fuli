import { readFileSync, statSync } from 'node:fs';

import { parse as parseToml } from 'smol-toml';

import { inspectAgentInstallations } from '../setup/agent-installation-status.js';
import { writeJsonFileAtomic } from '../storage/json-file.js';

// Kept per client so a long-lived console cannot grow this file without bound.
const MAX_CHANGES = 5;
// Statuses that prove a FULI entry was present in the client's configuration.
const PRESENT = new Set(['connected', 'changed']);
// Statuses an observation can persist; "unknown" is never stored as fact.
const STATUSES = new Set(['connected', 'changed', 'skills_left', 'removed', 'not_connected', 'not_detected']);
// Only these errors mean the file or one of its parents does not exist.
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Observe which supported clients have a FULI integration in their local
 * configuration. This reads configuration only: it never proves a client is
 * running or that its MCP session is reachable, and it never reinstalls.
 */
export function createClientConnectionObserver({
  discover,
  context,
  historyPath,
  now = () => new Date(),
  inspect = inspectAgentInstallations
}) {
  // History that could not be written stays reliable for this observer.
  let retained = null;

  function observe() {
    const observedAt = now().toISOString();
    const unreadable = new Set();
    // Null means absent or unreadable; an existing file always yields a string.
    const read = (path) => {
      try { return readFileSync(path, 'utf8'); } catch (error) {
        if (!ABSENT.has(error?.code)) unreadable.add(path);
        return null;
      }
    };
    // Existing readers turn read and parse failures into "missing"; these
    // record them so an unreadable file is never reported as a removal.
    const readText = (path) => {
      const text = read(path) ?? '';
      // Validate only; user TOML is never rewritten and its values never leave here.
      if (text && path.endsWith('.toml')) {
        try { parseToml(text, { integersAsBigInt: 'asNeeded' }); } catch { unreadable.add(path); return ''; }
      }
      return text;
    };
    // Only an absent file is empty configuration; existing empty JSON is malformed.
    const readJson = (path) => {
      const text = read(path);
      if (text === null) return {};
      try { return JSON.parse(text); } catch { unreadable.add(path); return {}; }
    };
    const fileExists = (path) => {
      try { statSync(path); return true; } catch (error) {
        if (!ABSENT.has(error?.code)) unreadable.add(path);
        return false;
      }
    };
    const agents = discover();
    const history = sanitizeHistory(retained ?? readHistory(historyPath), agents);
    let dirty = retained !== null;
    const clients = inspect(agents, context, { readText, readJson, fileExists }).map((agent) => {
      const record = history.clients[agent.id] ?? { status: null, previouslyConnected: false, since: null, changes: [] };
      if (ownPaths(agent).some((path) => unreadable.has(path))) {
        return view(agent, { ...record, status: 'unknown' }, { lastKnownStatus: record.status });
      }
      const previouslyConnected = record.previouslyConnected || PRESENT.has(statusOf(agent, false));
      const status = statusOf(agent, previouslyConnected);
      if (status !== record.status || previouslyConnected !== record.previouslyConnected) {
        const changes = record.status && status !== record.status
          ? [...record.changes, { from: record.status, to: status, detectedAt: observedAt }].slice(-MAX_CHANGES)
          : record.changes;
        history.clients[agent.id] = { status, previouslyConnected,
          since: status === record.status ? record.since : observedAt, changes };
        dirty = true;
      }
      return view(agent, history.clients[agent.id] ?? record, { components: agent.integrationDetails });
    });
    let historySaved = true;
    if (dirty) {
      try { writeJsonFileAtomic(historyPath, history); retained = null; } catch { retained = history; historySaved = false; }
    }
    return { scope: 'configuration', observedAt, historySaved, clients };
  }
  return { observe };
}

// Skill folders a discovered client declares; MCP-only clients declare none.
const SKILL_PATHS = ['skillPath', 'projectSkillPath', 'reviewSkillPath', 'operationSkillPath'];

function statusOf(agent, previouslyConnected) {
  const { mcp, skills } = agent.integrationDetails;
  if (agent.integrationStatus === 'connected') return 'connected';
  if (mcp !== 'missing') return 'changed';
  // Inspection reports "current" for a client with no Skill folders at all,
  // which is not evidence of leftover Skills.
  if (skills !== 'missing' && SKILL_PATHS.some((key) => agent[key])) return 'skills_left';
  if (previouslyConnected) return 'removed';
  return agent.available ? 'not_connected' : 'not_detected';
}

// The client's own configuration files, as declared by discovery.
function ownPaths(agent) {
  return Object.entries(agent)
    .filter(([key, value]) => key.endsWith('Path') && typeof value === 'string')
    .map(([, value]) => value);
}

// Only bounded, path-free fields leave this module.
function view(agent, record, extra) {
  return { id: agent.id, label: agent.label, detected: Boolean(agent.available),
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
function sanitizeHistory(value, agents) {
  const clients = {};
  const stored = value?.version === 1 && isObject(value.clients) ? value.clients : {};
  for (const { id } of agents) {
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
