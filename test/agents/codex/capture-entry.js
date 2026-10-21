// How a Codex turn enters FULI, for the capture parity check of every
// lifecycle client (test/capture-client-parity.test.js, rec#5 C4-5).
import { codexEntry } from '../../fixtures/capture-project-fixture.js';

// entryMessage: the hook shows the person a line at entry (systemMessage).
export const captureClient = Object.freeze({ sourceApplication: 'codex', entry: codexEntry, entryMessage: true });
