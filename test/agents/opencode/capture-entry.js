// How an OpenCode turn enters FULI, for the capture parity check of every
// lifecycle client (test/capture-client-parity.test.js, rec#5 C4-5).
import { openCodeEntry } from '../../fixtures/capture-project-fixture.js';

// OpenCode's plugin shows the person no line at entry: the entry goes to the
// model as system text, and the person reads the receipt in its reply.
export const captureClient = Object.freeze({ sourceApplication: 'other', entry: openCodeEntry, entryMessage: false });
