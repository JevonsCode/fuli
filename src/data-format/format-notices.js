import { inspectLocalStores } from './local-stores.js';

// The local stores this FULI cannot use as they are, by store and step, for
// the console's startup log and /api/health (rec#17 D-09). Read only, like
// `fuli migrate status`; a short cache keeps health polling cheap.

const NOTICE_STATES = new Set(['pending_confirmation', 'half_applied', 'newer_format', 'newer_readable',
  'unsupported', 'unavailable']);
const NOTICE_TTL_MS = 10_000;

export function dataFormatNotices(dataDir, { inspect = inspectLocalStores, now = Date.now } = {}) {
  let cached = null;
  return () => {
    if (cached && now() - cached.at < NOTICE_TTL_MS) return cached.notices;
    const notices = inspect(dataDir).filter((store) => NOTICE_STATES.has(store.state))
      .map(({ store, label, state, steps }) => ({ store, label, state, steps: steps.map((step) => step.id) }));
    cached = { at: now(), notices };
    return notices;
  };
}

export function dataFormatNoticeLine({ store, label, state, steps }) {
  return `Data format: store ${store} (${label}) is ${state}${steps.length ? `; steps ${steps.join(', ')}` : ''}. `
    + 'Run `fuli migrate status` for details.';
}
