import { dirname } from 'node:path';

import { externalWritersLines } from './external-writers.js';
import { PERSONAL_GRAPH_LABEL, personalGraphFormatState } from './format-status.js';
import { inspectLocalStores } from './local-stores.js';
import { readFormatOperations } from './operations-log.js';

// The local stores this FULI cannot use as they are, by store and step, for
// the console's startup log and /api/health (rec#17 D-09). Read only, like
// `fuli migrate status`; a short cache keeps health polling cheap.

const NOTICE_STATES = new Set(['pending_confirmation', 'half_applied', 'newer_format', 'newer_readable',
  'unsupported', 'unavailable']);
const NOTICE_TTL_MS = 10_000;
const WAITING_STEP_STATES = new Set(['pending_confirmation', 'half_applied']);

export function dataFormatNotices(dataDir, { inspect = inspectLocalStores, now = Date.now } = {}) {
  let cached = null;
  return () => {
    if (cached && now() - cached.at < NOTICE_TTL_MS) return cached.notices;
    const notices = inspect(dataDir).filter((store) => NOTICE_STATES.has(store.state))
      .map(({ store, label, state, steps }) => ({ store, label, state, steps: waitingSteps(steps) }));
    cached = { at: now(), notices };
    return notices;
  };
}

// The steps that hold the store, not the automatic ones before them.
function waitingSteps(steps) {
  const waiting = steps.filter((step) => WAITING_STEP_STATES.has(step.state));
  return (waiting.length ? waiting : steps).map((step) => step.id);
}

export function dataFormatNoticeLine({ store, label, state, steps }) {
  return `Data format: store ${store} (${label}) is ${state}${steps.length ? `; steps ${steps.join(', ')}` : ''}. `
    + 'Run `fuli migrate status` for details.';
}

// How long an applied migration is still mentioned in a receipt.
const APPLIED_NOTICE_MS = 24 * 60 * 60 * 1000;
const GRAPH_STATE_TTL_MS = 60_000;

// The receipt's data format notice (rec#17 D-09 part 2, rec#20), from the
// same notices the console reports plus the operations log: a step waiting
// for a person, or a migration applied in the last day. null — no bytes at
// all — when there is neither. graphState() resolves the personal graph's
// format state from its provider health ({ state, pending }) or null.
export function dataFormatReceiptNotice(dataDir, { notices = dataFormatNotices(dataDir),
  operations = () => readFormatOperations(dataDir), graphState = async () => null, now = Date.now } = {}) {
  let graphCache = null;
  const graphPending = async () => {
    if (!graphCache || now() - graphCache.at >= GRAPH_STATE_TTL_MS) {
      let state = null;
      try { state = await graphState(); } catch { state = null; }
      graphCache = { at: now(), steps: state?.state === 'pending_confirmation' ? state.pending ?? [] : [] };
    }
    return graphCache.steps;
  };
  return async () => {
    const pending = [...notices().filter((notice) => notice.state === 'pending_confirmation')
      .flatMap((notice) => notice.steps.length ? notice.steps : [notice.store]), ...await graphPending()];
    const applied = operations().filter((event) => event.kind === 'applied'
      && now() - Date.parse(event.at) < APPLIED_NOTICE_MS).map((event) => event.migrationId);
    return [
      pending.length ? `数据格式待确认：${several(pending)}（fuli migrate preview）` : null,
      applied.length ? `数据格式已迁移：${several(applied.reverse())}` : null
    ].filter(Boolean).join(' · ') || null;
  };
}

function several(ids) {
  return ids.length > 1 ? `${ids[0]} 等 ${ids.length} 项` : ids[0];
}

// The receipt notice of a FULI application with a local data directory
// (its runtime config's directory): its stores, and its personal graph's
// state from the provider's health. One per application, built on first use;
// none for an application without a data directory.
const APPLICATION_NOTICES = new WeakMap();

function applicationFormatNotice(application) {
  if (!application.runtimeConfigPath) return null;
  if (!APPLICATION_NOTICES.has(application)) {
    APPLICATION_NOTICES.set(application, dataFormatReceiptNotice(dirname(application.runtimeConfigPath),
      { graphState: async () => (await application.personal.health())?.data_format ?? null }));
  }
  return APPLICATION_NOTICES.get(application);
}

export async function receiptFormatNotices(application) {
  const notice = await applicationFormatNotice(application)?.();
  return notice ? [notice] : [];
}

// What `fuli setup` says when stores wait for a person: which ones (the local
// stores, and the personal graph when its provider's health says a step waits
// for a confirmation), where to review them, and the boundary of applying
// them. null when none. A provider that does not answer is left out.
export async function setupMigrationNotice(dataDir, { notices = dataFormatNotices(dataDir),
  graphState = () => personalGraphFormatState(dataDir) } = {}) {
  const waiting = notices().filter((notice) => WAITING_STEP_STATES.has(notice.state)).map((notice) => notice.label);
  let graph = null;
  try { graph = await graphState(); } catch { graph = null; }
  if (graph?.state === 'pending_confirmation') waiting.push(PERSONAL_GRAPH_LABEL);
  if (!waiting.length) return null;
  return [`Data format migrations wait for you: ${waiting.join(', ')}. `
    + 'Review them with fuli migrate preview, or in the console under Settings → Data format migrations.',
  ...externalWritersLines()].join('\n');
}
