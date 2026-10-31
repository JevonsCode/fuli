// Whether Codex trusts FULI's lifecycle hooks is Codex's own record, and FULI
// cannot read it (rec#11 plan item 9). Codex runs a non-managed hook only
// after the person trusts its exact definition in /hooks; it stores that as
// `hooks.state."<source path>:<event>:<group>:<handler>".trusted_hash` in its
// config.toml and compares it with a hash of its own normalized form of the
// hook. Codex calls that value opaque (app-server `hooks/list`), and the form
// changes with Codex releases, so FULI never recomputes it: a guess would
// report trusted hooks as untrusted, or the reverse. The doctor names Codex
// in its `unchecked` list instead, and installing never edits Codex's trust
// (lifecycle-hooks.js).
export const CODEX_HOOK_TRUST_CLIENT = 'codex';
