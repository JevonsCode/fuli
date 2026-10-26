import { transcriptDigest, transcriptGuardFailureMessage, withTranscriptGuard } from './transcript-guard.js';
import { syncConversationTranscript, claimTranscriptBoundary, keepEnteredHandoff, recordTranscriptTaskEntry,
  transcriptCaptureScope, withTranscriptNotice } from './sync-transcript.js';
import { captureDecision, captureSettingsVersion, withCaptureLookups } from '../graphiti/capture-decision.js';
import { keepDenial, keepUnsynced, transcriptCaptureLedger, UNATTRIBUTABLE } from './transcript-capture-gap.js';
import { captureNotice } from '../graphiti/capture-notice.js';
import { recoverFailedTranscriptEntry } from './fallback-transcript-boundary.js';
import { captureWindow, withCaptureBudget } from './capture-window.js';

const TIMED_OUT = 'transcript_capture_timeout';

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
  // The version is read before the decision: a change in between then either
  // denies here or stops every write of this run (capture-window.js).
  const settings = captureSettingsVersion(application, input?.session_id ?? null);
  const captureCheck = await captureDecision(application, transcriptCaptureScope(input, sourceApplication));
  const enabled = captureCheck.allowed;
  // Each entry says when automatic recording is off (rec#11 D-01); Stop stays
  // quiet. A hook that skipped a stretch because the settings changed, or that
  // could not keep a denial safely, says so.
  const notice = entry ? captureNotice(captureCheck.reason, captureCheck.since) : null;
  let captureState = null;
  const withCaptureNotice = (value, skipped) => {
    const lines = [...new Set([notice, captureNotice(skipped), captureNotice(captureState)].filter(Boolean))]
      .map(text => `Fuli: ${text}`);
    return lines.length ? { ...value, systemMessage: [value.systemMessage, ...lines].filter(Boolean).join('\n') } : value;
  };
  // Turns written while the capture settings changed since this session last
  // synchronized, or while a decision denied, are skipped, not imported
  // (transcript-capture-gap.js). A denial is kept locally first, so a Provider
  // that cannot take its marker now cannot make the stretch importable later.
  const ledger = input?.session_id ? transcriptCaptureLedger(runtimeConfigPath, input, sourceApplication) : null;
  if (!enabled) captureState = await keepDenial(application, ledger, settings, captureCheck.reason);
  const notRecorded = enabled ? (ledger ? await ledger.skipReason(settings) : UNATTRIBUTABLE) : null;
  const settle = async sync => {
    if (!ledger || !enabled) return;
    // A denial found inside the sync (the session's task is in a project that
    // is not recorded) is kept the same way.
    if (sync?.status === 'capture_disabled') captureState ??= await keepDenial(application, ledger, settings, sync.reason);
    // A pause or switch saved meanwhile keeps what it wrote to the ledger.
    else if (['saved', 'ready'].includes(sync?.status)
      && captureSettingsVersion(application, input.session_id) === settings) ledger.record(settings);
  };
  let started = false, output, context;
  const invoke = async ({ continued = false } = {}) => {
    started = true;
    output = await withCaptureBudget(captureTimeoutMs, () => run(value => { context = value; }), { continued });
    return output;
  };
  try {
    return await withTranscriptGuard(runtimeConfigPath, input, sourceApplication, enabled, async guard => {
      const capture = async operation => {
        try {
          return await captureWindow(application, guard, operation, { timeoutMs: captureTimeoutMs, signal, settings,
            sessionId: input?.session_id ?? null });
        } catch (error) {
          // A stretch that a settings change interrupted is skipped at the next sync.
          return error?.code === 'capture_changed'
            ? { status: 'unsaved', entryBlocked: entry, code: 'capture_changed',
              reason: 'Capture settings changed during this import; nothing more was written' }
            : { status: 'unsaved', entryBlocked: entry, code: TIMED_OUT,
              reason: 'Native transcript import was deferred; preferences and current task context are independent' };
        }
      };
      let owner = null;
      let sync = await capture((app, held) => syncConversationTranscript(app, input, sourceApplication, adapter, held,
        { notRecorded, unsynced: ledger?.unsyncedSpan() ?? null, onTask: task => { owner = transcriptDigest(task.token); } }));
      const skipped = sync.skipped ?? null;
      // A Stop cut short keeps what it decided for the bytes it saw, so a hook
      // while capture is then denied does not call them off (rec#16).
      if (!entry && enabled && [TIMED_OUT, 'capture_changed'].includes(sync.code)) {
        await keepUnsynced(application, ledger, input, adapter,
          { settings, notRecorded, owner, handoffPending: Boolean(guard?.value) });
      }
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
        // A capture that ran out of time is continued by the next hook; say so,
        // so a report can tell a slow import from unverified history.
        if (sync.code === TIMED_OUT) await keepEnteredHandoff(guard, input, adapter, context).catch(() => {});
        return withTranscriptNotice(output, { ...sync, status: 'partial',
          reason: sync.code === TIMED_OUT ? sync.reason
            : 'Unverified native transcript history was not imported; preferences and current task context are available' });
      }
      const entryGuard = sync.status === 'capture_disabled' ? null : guard;
      if (entry && entryGuard?.value) await entryGuard.write({ ...entryGuard.value, phase: 'beginning' });
      // The guard now records this entry: the claim below, or the next hook
      // (keepEnteredHandoff), hands the transcript to the entered task, whose
      // import writes its conversation. A begin cut short is deferred to it.
      await invoke({ continued: Boolean(entry && entryGuard?.value) });
      if (entry) {
        sync = await capture(async (app, held) => {
          await recordTranscriptTaskEntry(entryGuard ? held : null, context);
          return claimTranscriptBoundary(app, input, sourceApplication, sync, adapter, entryGuard ? held : null);
        });
        if (sync.code === TIMED_OUT) await keepEnteredHandoff(entryGuard, input, adapter, context).catch(() => {});
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
