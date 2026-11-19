import { ApplicationError } from '../app/application-error.js';
import { activeRunnerCaller } from '../app/agent-request-context.js';
import { DIAGNOSTIC_EVENTS_TOOL, HOST_DIAGNOSTICS_ONLY } from './agent-access.js';
import { diagnosticEventsAnswer } from './query.js';

// The Agent side of the diagnostics log (rec#73): the same read as GET
// /api/diagnostics/events and `fuli diagnostics`. Read only.
export const DIAGNOSTIC_HANDLERS = Object.freeze({
  [DIAGNOSTIC_EVENTS_TOOL]: (app, input) => {
    if (activeRunnerCaller()) throw new ApplicationError('local_user_only', HOST_DIAGNOSTICS_ONLY, { status: 403 });
    if (!app.diagnosticEvents) {
      throw new ApplicationError('diagnostics_unavailable', 'Diagnostic events need a local FULI installation; '
        + 'run fuli diagnostics on this computer', { status: 503 });
    }
    return diagnosticEventsAnswer(app.diagnosticEvents, input);
  }
});
