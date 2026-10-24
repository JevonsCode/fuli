import { approvalBinds } from './authorization.js';
import { TERMINAL_CONFIRMATION } from './decision-source.js';
import { storedPackageMatches } from './package-files.js';
import { TERMS_VERSION, TRUST_MODE } from './trust-terms.js';

// The fixed reasons a run is refused (rec#7 D-28.2, rec#11 D-36.2).
const RUN_REFUSALS = Object.freeze({
  confirmation_required: 'The running version has not been confirmed at a terminal; approve or roll back with '
    + 'fuli app approve/rollback.',
  reconfirmation_required: 'This version was approved under earlier terms (isolated mode), which do not cover running it '
    + 'with your account\'s permissions; confirm it again with fuli app rollback <app> <version> '
    + '(该版本是按旧的隔离模式批准的，不会自动转为受信任模式，请重新确认).',
  challenge_mismatch: 'The confirmed challenge does not cover the approved terms or the package on disk.',
  runner_check_failed: 'The app runner\'s self-check failed, so no app code runs.'
});

// The run gate every start of an app passes (on demand, idle restart, resident
// launch). It reads the persisted approval of the active version and never
// asks again: the terminal confirmation was fresh for the approval or rollback
// that activated the version. It passes when that approval completed the
// terminal confirmation flow under this version's terms (trusted mode,
// trust-terms.js), its challenge is recorded as confirmed, it covers the
// version's terms and the package on disk still has the approved digest. An
// approval from the console, from an earlier FULI (the isolated mode, Windows
// Hello approvals included) or under other terms never passes. ready means
// the runner may go on to its self-check; this version has no sandbox, so the
// app then runs with the user's own permissions.
export function createRunGate(context) {
  const { store } = context;

  function runGate({ appId }) {
    const app = store.existingApp(appId);
    const approval = app.status === 'active' ? store.approval(appId, app.activeVersion) : null;
    if (!approval?.challengeId || !approval.verifiedAt) return runRefused('confirmation_required');
    if (approval.verification !== TERMINAL_CONFIRMATION || approval.trustMode !== TRUST_MODE
      || approval.termsVersion !== TERMS_VERSION) {
      return runRefused('reconfirmation_required');
    }
    const version = store.version(appId, app.activeVersion);
    if (!store.challengeConfirmed(appId, approval.challengeId) || !approvalBinds(approval, version)
      || !storedPackageMatches(context.packageOf(appId, version.version), approval.digest)) {
      return runRefused('challenge_mismatch');
    }
    return { status: 'ready', trustMode: approval.trustMode };
  }

  return { runGate };
}

export const runRefused = (reason) => ({ status: 'run_refused', reason, message: RUN_REFUSALS[reason] });
