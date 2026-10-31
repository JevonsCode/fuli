import { randomUUID } from 'node:crypto';

import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { positiveInteger, requiredString } from '../validation/values.js';
import { WorkSurfaceStore } from './store.js';

// One table of every FLA's work surfaces (rec#11 D-85), with 全部暂停 and 恢复.
// Each kind's owner lists its items and, where it has a safe off switch,
// turns one off and back on (sources.js); this port only gathers, filters,
// remembers and records. A pause snapshots each matching item's on/off state
// before it turns anything off; a resume reopens exactly the items that were
// on in that snapshot, so an item that was already off stays off. The person
// and Agents may both do it; nothing here asks for approval. Pauses and
// resumes run one at a time in this process.
const LIMITS = Object.freeze({ id: 200, query: 200, state: 40 });
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 100;

export function createWorkSurfaces({ path = ':memory:', sources, names, now = () => new Date(),
  newId = () => `pause-${randomUUID()}` }) {
  const store = new WorkSurfaceStore(path);
  const at = () => now().toISOString();
  const kinds = Object.keys(sources);
  let queue = Promise.resolve();

  // One pause or resume at a time, so a resume never reads a snapshot a pause is still taking.
  function serial(work) {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  }

  // Every kind's rows with their owners' names. A kind whose owner cannot be
  // read is reported in unavailable instead of failing the whole table.
  async function gather(personalSpaceId) {
    const [named, ...listed] = await Promise.allSettled([names(personalSpaceId),
      ...kinds.map((kind) => sources[kind].list(personalSpaceId))]);
    const unavailable = [];
    const lookup = named.status === 'fulfilled' ? named.value : { agents: new Map(), projects: new Map() };
    if (named.status === 'rejected') unavailable.push(unavailableEntry('names', named.reason));
    const rows = listed.flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      unavailable.push(unavailableEntry(kinds[index], result.reason));
      return [];
    }).map((row) => {
      const agent = lookup.agents.get(row.agentId);
      const personalProjectId = row.personalProjectId ?? agent?.personalProjectId ?? null;
      return { ...row, agentName: agent?.name ?? null, personalProjectId,
        projectName: lookup.projects.get(personalProjectId) ?? null };
    });
    return { rows, unavailable };
  }

  async function list({ personalSpaceId, filter: input }) {
    const filter = filterOf(input, kinds);
    const { rows, unavailable } = await gather(personalSpaceId);
    return { items: rows.filter((row) => matches(row, filter)).map(publicRow), unavailable,
      partial: unavailable.length > 0, checkedAt: at() };
  }

  function pause({ personalSpaceId, filter: input, actor }) {
    const filter = filterOf(input, kinds);
    return serial(async () => {
      const { rows, unavailable } = await gather(personalSpaceId);
      const matched = rows.filter((row) => matches(row, filter));
      const covered = matched.filter((row) => row.pausable);
      const skipped = matched.length - covered.length;
      if (!covered.length) return { status: 'nothing_to_pause', pauseId: null, results: [], skipped, unavailable };
      const pauseId = newId();
      store.transaction(() => store.addPause({ pauseId, personalSpaceId, filter, createdAt: at(), items: covered }));
      const results = [];
      for (const row of covered) results.push(row.on ? await pauseOne(row, actor) : result(row, row.on, 'already_off'));
      store.transaction(() => store.addAction({ pauseId, action: 'pause', actor, at: at(), results }));
      return { status: 'paused', pauseId, results, skipped, unavailable };
    });
  }

  async function pauseOne(row, actor) {
    try {
      const outcome = await sources[row.kind].pause(row, actor);
      return result(row, true, outcome.status, outcome.detail);
    } catch (error) {
      return result(row, true, 'failed', failure(error));
    }
  }

  // Without pauseId, the space's latest pause. A resume may be repeated: an
  // item already back on is reported as already_on and left alone.
  function resume({ personalSpaceId, pauseId, actor }) {
    return serial(async () => {
      const snapshot = pauseId === undefined || pauseId === null ? store.latestPause(personalSpaceId)
        : store.pause(requiredString(pauseId, 'pauseId', LIMITS.id));
      if (!snapshot || snapshot.personalSpaceId !== personalSpaceId) {
        throw new ApplicationError('pause_not_found', 'No pause in this space has this pauseId', { status: 404 });
      }
      const { rows, unavailable } = await gather(personalSpaceId);
      const current = new Map(rows.map((row) => [rowKey(row), row]));
      const down = new Set(unavailable.map(({ kind }) => kind));
      const results = [];
      for (const item of store.items(snapshot.pauseId)) {
        results.push(await resumeOne(item, current.get(rowKey(item)), down.has(item.kind), actor));
      }
      store.transaction(() => store.addAction({ pauseId: snapshot.pauseId, action: 'resume', actor, at: at(), results }));
      return { status: 'resumed', pauseId: snapshot.pauseId, results, unavailable };
    });
  }

  async function resumeOne(item, row, unreadable, actor) {
    if (!item.wasOn) return result(item, false, 'left_off');
    if (unreadable) return result(item, true, 'failed', { code: 'owner_unavailable' });
    if (!row) return result(item, true, 'gone');
    if (row.on) return result(item, true, 'already_on');
    try {
      const outcome = await sources[item.kind].resume({ ...row, resume: item.resume }, actor);
      return result(item, true, outcome.status, outcome.detail);
    } catch (error) {
      return result(item, true, 'failed', failure(error));
    }
  }

  // The newest pauses first, each with what it covered and every pause and resume of it.
  function history({ personalSpaceId, limit }) {
    const count = limit === undefined || limit === null ? HISTORY_DEFAULT : positiveInteger(limit, 'limit', HISTORY_MAX);
    return { pauses: store.pauses(personalSpaceId, count).map((pause) => ({ ...pause,
      items: store.items(pause.pauseId).map(({ resume, ...item }) => item), actions: store.actions(pause.pauseId) })) };
  }

  return { list, pause, resume, history, close: () => store.close() };
}

const rowKey = ({ kind, id }) => `${kind}\u0000${id}`;

function result(item, wasOn, status, detail) {
  return { kind: item.kind, id: item.id, name: item.name, wasOn, result: status, ...(detail ? { detail } : {}) };
}

// The owner's own code and message; anything else is reported without its text.
function failure(error) {
  return typeof error?.code === 'string' ? { code: error.code, message: error.message } : { code: 'failed' };
}

function unavailableEntry(kind, error) {
  return { kind, code: typeof error?.code === 'string' ? error.code : 'unavailable' };
}

// What a caller sees of a row: no resume details.
function publicRow({ resume, ...row }) {
  return row;
}

// An absent, null or empty field does not filter (a console query string sends empty ones).
function filterOf(input, kinds) {
  const given = (value) => value !== undefined && value !== null && value !== '';
  const kind = given(input?.kind) ? requiredString(input.kind, 'kind', LIMITS.state) : null;
  if (kind && !kinds.includes(kind)) throw new InvalidInputError(`kind must be one of ${kinds.join(', ')}`);
  return {
    agentId: given(input?.agentId) ? requiredString(input.agentId, 'agentId', LIMITS.id) : null,
    personalProjectId: given(input?.personalProjectId)
      ? requiredString(input.personalProjectId, 'personalProjectId', LIMITS.id) : null,
    kind,
    state: given(input?.state) ? requiredString(input.state, 'state', LIMITS.state) : null,
    q: given(input?.q) ? requiredString(input.q, 'q', LIMITS.query).toLowerCase() : null
  };
}

function matches(row, filter) {
  if (filter.kind && row.kind !== filter.kind) return false;
  if (filter.agentId && row.agentId !== filter.agentId) return false;
  if (filter.personalProjectId && row.personalProjectId !== filter.personalProjectId) return false;
  if (filter.state && row.state !== filter.state) return false;
  return !filter.q || [row.name, row.id, row.agentId, row.agentName, row.personalProjectId, row.projectName]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(filter.q));
}
