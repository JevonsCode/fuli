// The isolation backend an app instance runs in (rec#7 D-28.2, D-28.10/11).
// This version has none: kind is null, so the run gate answers
// isolation_unavailable and no app code ever starts. A backend (AppContainer
// in rec#7 PR③) implements:
// - selfCheck() → { ok: true } or { ok: false, detail }: the probe that must
//   pass before every start (isolation_probe_failed otherwise);
// - start({ appId, instanceId, generation, mode, packageDirectory,
//   dataDirectory, manifest, environment }) → a handle { pid, pidIdentity,
//   exePath, socket } that keeps the backend's own reference to the process;
//   environment holds only FULI_APP_* values;
// - stop(handle): stops the process through that reference and waits for its exit;
// - stopOrphan(instance): stops the process of an instance whose host has
//   exited, only through an identity-checked reference, or answers that it
//   has nothing to stop. A backend never falls back to a plain spawn or a
//   signal by PID.
export const NO_ISOLATION = Object.freeze({
  kind: null,
  selfCheck: async () => ({ ok: false, detail: 'no_backend' }),
  start: async () => { throw new Error('No isolation backend: no app code runs'); },
  stop: async () => {},
  // Without a backend no instance process was ever started.
  stopOrphan: async () => ({ stopped: false, reason: 'not_running' })
});
