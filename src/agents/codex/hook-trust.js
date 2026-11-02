import { createCodexHookTrustReader } from './hook-trust-reader.js';

// Whether Codex trusts FULI's lifecycle hooks is Codex's own record. Codex
// runs a non-managed hook only after the person trusts its exact definition in
// /hooks; it stores that in its config.toml and compares it with a hash of its
// own normalized form of the hook. The form changes with Codex releases, so
// FULI never recomputes it. Codex's app-server now reports the trust status it
// stored (hooks/list), so the doctor reads that answer instead of guessing
// (hook-trust-reader.js). Installing never edits Codex's trust
// (lifecycle-hooks.js).
export const CODEX_HOOK_TRUST_CLIENT = 'codex';

// A read spawns Codex's CLI, so the doctor asks at most once per check and
// reuses the last answer for a minute.
const HOOK_TRUST_CACHE_MS = 60_000;

export function createCodexHookTrust({ reader = createCodexHookTrustReader(), cacheMs = HOOK_TRUST_CACHE_MS,
  now = () => Date.now() } = {}) {
  let cached = null;
  return async function read() {
    if (cached && now() - cached.at < cacheMs) return cached.result;
    const result = await reader();
    cached = { at: now(), result };
    return result;
  };
}
