import { presenceKindFor } from '../presence/platforms.js';
import { approvalBinds } from './authorization.js';
import { OS_USER_VERIFIED } from './decision-source.js';
import { storedPackageMatches } from './package-files.js';

// The fixed reasons a run is refused (rec#7 D-28.2).
const RUN_REFUSALS = Object.freeze({
  presence_unverified: 'The running version has no presence-checked approval; approve or roll back with fuli app approve/rollback.',
  presence_unsupported_platform: 'This platform has no presence check yet, so apps cannot run (本平台尚无在场证明，应用不能运行).',
  challenge_mismatch: 'The verified challenge does not cover the approved terms or the package on disk.',
  isolation_unavailable: 'No isolation backend is available, so no app code runs.',
  isolation_probe_failed: 'The isolation self-check failed, so no app code runs.'
});

// The run gate every start of an app passes (on demand, idle restart, resident
// launch). It reads the persisted approval of the active version and never
// asks for presence again: the check was fresh for the approval or rollback
// that activated the version (D-28.8). Passing it then needs an isolation
// backend (isolation.js); this version ships none (rec#7 PR③ adds one), so even
// a fully verified approval stops at isolation_unavailable and nothing runs.
// ready means the runner may go on to the backend's self-check.
export function createRunGate(context) {
  const { store } = context;

  function runGate({ appId }) {
    const kind = presenceKindFor(context.platform);
    if (!kind) return runRefused('presence_unsupported_platform');
    const app = store.existingApp(appId);
    const approval = app.status === 'active' ? store.approval(appId, app.activeVersion) : null;
    if (!approval || approval.presence !== kind || approval.verification !== OS_USER_VERIFIED
      || !approval.challengeId || !approval.verifiedAt) {
      return runRefused('presence_unverified');
    }
    const version = store.version(appId, app.activeVersion);
    if (!store.challengeVerified(appId, approval.challengeId) || !approvalBinds(approval, version)
      || !storedPackageMatches(context.packageOf(appId, version.version), approval.digest)) {
      return runRefused('challenge_mismatch');
    }
    return context.isolation.kind ? { status: 'ready' } : runRefused('isolation_unavailable');
  }

  return { runGate };
}

export const runRefused = (reason) => ({ status: 'run_refused', reason, message: RUN_REFUSALS[reason] });
