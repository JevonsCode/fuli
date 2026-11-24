import { SCOPE_ENVELOPE_MAX_BYTES } from './protocol.js';
import { GLOBAL_SCOPE } from './routes-store.js';

// A host's answer to a follower asking for a scope it owns, for that
// follower's read-only copy (docs/runner-roles-design.md §3, §12 "The sync
// loop"). The envelope is this computer's own Provider's export, handed on as
// the text the Provider wrote, never parsed and written again (its numbers and
// digest would change). Only `global` is offered in this version; each
// project's copy is a later step.
//
// An export reads the whole personal space (about a second for a person's
// global), and a follower asks twice: the digest first, then, only when it
// changed, the envelope. One export answers both: it is kept KEEP_MS, and while
// one runs every other ask of that scope waits for it, so however many
// followers ask, this computer exports a scope at most once per KEEP_MS. The
// text kept is let go of after KEEP_MS (it can be tens of megabytes).
// A failed export is not kept: the next ask tries again.
export const SCOPE_EXPORT_KEEP_MS = 60_000;
// How long one ask waits for the export. A Provider that does not run answers at once
// (host_provider_unavailable); one slower than this is said as slow, and the export it started
// goes on and is kept for the next ask. The follower's other calls never wait on it: they go
// through their own requests.
export const SCOPE_EXPORT_WAIT_MS = 20_000;

// ownsScope(scope): whether this computer writes the scope (its routes store sends it nowhere).
export function createScopeExport({ app, ownsScope = () => true, now = Date.now, keepMs = SCOPE_EXPORT_KEEP_MS,
  waitMs = SCOPE_EXPORT_WAIT_MS, maxBytes = SCOPE_ENVELOPE_MAX_BYTES }) {
  const kept = new Map(); // scope → { at, exported }
  const running = new Map(); // scope → Promise<{ exported } | { error }>

  function exportOnce(scope) {
    const fresh = kept.get(scope);
    if (fresh && now() - fresh.at < keepMs) return Promise.resolve({ exported: fresh.exported });
    if (!running.has(scope)) {
      const job = Promise.resolve()
        .then(() => app.personal.exportScope({ personalSpaceId: app.config.personal.spaceId, scope }))
        .then((exported) => {
          const entry = { at: now(), exported };
          kept.set(scope, entry);
          setTimeout(() => { if (kept.get(scope) === entry) kept.delete(scope); }, keepMs).unref?.();
          return { exported };
        }, (error) => ({ error }))
        .finally(() => running.delete(scope));
      running.set(scope, job);
    }
    return running.get(scope);
  }

  // part: 'digest' (a few fields) or 'envelope' (the text). Answers { status, body } for JSON,
  // or { status: 200, text, digest } for the envelope.
  async function answer(scope, part) {
    if (scope !== GLOBAL_SCOPE) return refusal(400, 'scope_not_offered', 'Only global is copied in this version.');
    if (!ownsScope(scope)) {
      return refusal(409, 'scope_not_owned_here', 'This computer keeps global as a read-only copy of another computer; '
        + 'only that computer exports it.');
    }
    if (typeof app?.personal?.exportScope !== 'function' || typeof app.config?.personal?.spaceId !== 'string') {
      return refusal(503, 'host_provider_unavailable', 'This computer\'s graph is not set up.');
    }
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), waitMs); });
    const outcome = await Promise.race([exportOnce(scope), late]).finally(() => clearTimeout(timer));
    if (outcome.late) return refusal(503, 'host_provider_slow', 'This computer\'s graph is slow to export now; ask again later.');
    if (outcome.error) return exportFailed(outcome.error);
    const exported = outcome.exported;
    if (exported.bytes > maxBytes) {
      return { status: 413, body: { error: 'scope_too_large', bytes: exported.bytes, max: maxBytes,
        message: `The ${scope} export is ${exported.bytes} bytes, more than the ${maxBytes} a copy takes.` } };
    }
    if (part === 'envelope') return { status: 200, text: exported.text, digest: exported.digest };
    return { status: 200, body: { scope: exported.scope, spaceId: exported.spaceId, digest: exported.digest,
      complete: exported.complete, graphFormat: exported.graphFormat, replicaProtocol: exported.replicaProtocol,
      bytes: exported.bytes } };
  }

  return { answer };
}

// The Provider's refusal as it said it (scope_not_owned_here, a format refusal); its being
// away or slow as this computer's own codes, so a follower never takes them for a refusal.
function exportFailed(error) {
  if (error?.status === 0) return refusal(503, 'host_provider_unavailable', 'This computer\'s graph does not run now.');
  if (error?.status === 504) return refusal(503, 'host_provider_slow', 'This computer\'s graph is slow to export now; ask again later.');
  if (error?.status >= 400 && error.status < 500) {
    return refusal(error.status, typeof error.code === 'string' ? error.code : 'host_export_refused',
      String(error.message ?? '').slice(0, 300));
  }
  return refusal(502, 'host_export_failed', 'This computer\'s graph did not export the scope.');
}

function refusal(status, code, message) {
  return { status, body: { error: code, message } };
}
