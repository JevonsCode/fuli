import { transcriptGuardFailureMessage, withTranscriptGuard } from './transcript-guard.js';
import { syncConversationTranscript, claimTranscriptBoundary, recordTranscriptTaskEntry, withTranscriptNotice } from './sync-transcript.js';
import { recoverFailedTranscriptEntry } from './fallback-transcript-boundary.js';
import { captureWindow, withCaptureBudget } from './capture-window.js';

// Transcript ownership is fail-closed; preference/task entry is independent.
// Both native adapters use this port so a capture failure cannot suppress a
// successful entry or cause a second begin after a partial runtime failure.
export async function transcriptLifecycle({ application, runtimeConfigPath, input, sourceApplication, event, adapter, run,
  captureTimeoutMs = 750, signal }) {
  const entry = event === 'UserPromptSubmit';
  const enabled = application.getCapturePolicy?.(sourceApplication).enabled;
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
      let sync = await capture((app, held) => syncConversationTranscript(app, input, sourceApplication, adapter, held));
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
      return withTranscriptNotice(output, sync);
    });
  } catch (error) {
    // An entry failure is a real entry failure. Never retry it and accidentally
    // supersede an already-created task under a different ownership token.
    if (!entry || !enabled || !input.transcript_path || (started && !output)) throw error;
    if (!output) await invoke();
    return withTranscriptNotice(output, { status: 'partial', reason: transcriptGuardFailureMessage(error) });
  }
}
