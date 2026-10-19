import { transcriptGuardFailureMessage, withTranscriptGuard } from './transcript-guard.js';
import { syncConversationTranscript, claimTranscriptBoundary, recordTranscriptTaskEntry, transcriptCaptureScope,
  withTranscriptNotice } from './sync-transcript.js';
import { captureDecision, captureSettingsVersion, withCaptureLookups } from '../graphiti/capture-decision.js';
import { transcriptCaptureLedger, UNATTRIBUTABLE } from './transcript-capture-gap.js';
import { captureNotice } from '../graphiti/capture-notice.js';
import { recoverFailedTranscriptEntry } from './fallback-transcript-boundary.js';
import { captureWindow, withCaptureBudget } from './capture-window.js';

// Transcript ownership is fail-closed; preference/task entry is independent.
// Both native adapters use this port so a capture failure cannot suppress a
// successful entry or cause a second begin after a partial runtime failure.
// Every capture decision of one hook run, including its task entry, shares
// one lookup of the session's directory.
export function transcriptLifecycle(options) {
  return withCaptureLookups(() => hookTranscriptLifecycle(options));
}

async function hookTranscriptLifecycle({ application, runtimeConfigPath, input, sourceApplication, event, adapter, run,
  captureTimeoutMs = 750, signal }) {
  const entry = event === 'UserPromptSubmit';
  const captureCheck = await captureDecision(application, transcriptCaptureScope(input, sourceApplication));
  const enabled = captureCheck.allowed;
  // Each entry says when automatic recording is off (rec#11 D-01); Stop stays
  // quiet. A hook that skipped a stretch because the settings changed says so.
  const notice = entry ? captureNotice(captureCheck.reason) : null;
  const withCaptureNotice = (value, skipped) => {
    const lines = [notice, captureNotice(skipped)].filter(Boolean).map(text => `Fuli: ${text}`);
    return lines.length ? { ...value, systemMessage: [value.systemMessage, ...lines].filter(Boolean).join('\n') } : value;
  };
  // Turns written while the capture settings changed since this session last
  // synchronized, or while a decision denied, are skipped, not imported
  // (transcript-capture-gap.js). A denial is kept locally first, so a Provider
  // that cannot take its marker now cannot make the stretch importable later.
  const settings = captureSettingsVersion(application);
  const ledger = input?.session_id ? transcriptCaptureLedger(runtimeConfigPath, input, sourceApplication) : null;
  if (!enabled) await ledger?.deny(settings, captureCheck.reason);
  const notRecorded = enabled ? (ledger ? await ledger.skipReason(settings) : UNATTRIBUTABLE) : null;
  const settle = async sync => {
    if (!ledger || !enabled) return;
    // A denial found inside the sync (the session's task is in a project that
    // is not recorded) is kept the same way.
    if (sync?.status === 'capture_disabled') await ledger.deny(settings, sync.reason);
    else if (['saved', 'ready'].includes(sync?.status)) ledger.record(settings);
  };
  let started = false, output, context;
  const invoke = async () => {
    started = true;
    output = await withCaptureBudget(captureTimeoutMs, () => run(value => { context = value; }));
    return output;
  };
  try {
    return await withTranscriptGuard(runtimeConfigPath, input, sourceApplication, enabled, async guard => {
      const capture = async operation => {
        try { return await captureWindow(application, guard, operation, { timeoutMs: captureTimeoutMs, signal }); }
        catch { return { status: 'unsaved', entryBlocked: entry, code: 'transcript_capture_timeout',
          reason: 'Native transcript import was deferred; preferences and current task context are independent' }; }
      };
      let sync = await capture((app, held) => syncConversationTranscript(app, input, sourceApplication, adapter, held,
        { notRecorded }));
      const skipped = sync.skipped ?? null;
      if (entry && sync.entryBlocked) {
        await invoke();
        // Only a held guard and the fresh entry's exact native ownership can
        // commit an omission. Lock contention and unavailable ownership never
        // advance a cursor or send uncertain text to the Provider.
        if (guard && context && !sync.code) {
          try {
            sync = await capture((app, held) => recoverFailedTranscriptEntry(app, input, sourceApplication, adapter, held, context)) ?? sync;
          } catch {
            // Keep the guard and old cursor retryable; task context is valid.
          }
        }
        // A capture that ran out of time is retried at the next hook; say so,
        // so a report can tell a slow import from unverified history.
        return withTranscriptNotice(output, { ...sync, status: 'partial',
          reason: sync.code === 'transcript_capture_timeout' ? sync.reason
            : 'Unverified native transcript history was not imported; preferences and current task context are available' });
      }
      const entryGuard = sync.status === 'capture_disabled' ? null : guard;
      if (entry && entryGuard?.value) await entryGuard.write({ ...entryGuard.value, phase: 'beginning' });
      await invoke();
      if (entry) {
        sync = await capture(async (app, held) => {
          await recordTranscriptTaskEntry(entryGuard ? held : null, context);
          return claimTranscriptBoundary(app, input, sourceApplication, sync, adapter, entryGuard ? held : null);
        });
      }
      await settle(sync);
      return withCaptureNotice(withTranscriptNotice(output, sync), skipped);
    });
  } catch (error) {
    // An entry failure is a real entry failure. Never retry it and accidentally
    // supersede an already-created task under a different ownership token.
    if (!entry || !enabled || !input.transcript_path || (started && !output)) throw error;
    if (!output) await invoke();
    return withTranscriptNotice(output, { status: 'partial', reason: transcriptGuardFailureMessage(error) });
  }
}
