import { ApplicationError } from '../app/application-error.js';
import { diagnosticEventsAnswer } from './query.js';

// The Agent side of the diagnostics log (rec#73): the same read as GET
// /api/diagnostics/events and `fuli diagnostics`. Read only.
export const DIAGNOSTIC_HANDLERS = Object.freeze({
  read_diagnostic_events: (app, input) => {
    if (!app.diagnosticEvents) {
      throw new ApplicationError('diagnostics_unavailable', 'Diagnostic events need a local FULI installation; '
        + 'run fuli diagnostics on this computer', { status: 503 });
    }
    return diagnosticEventsAnswer(app.diagnosticEvents, input);
  }
});
