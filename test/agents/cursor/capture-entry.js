// How a Cursor turn enters FULI, for the capture parity check of every
// lifecycle client (test/capture-client-parity.test.js, rec#5 C4-5).
import { cursorEntry } from '../../fixtures/capture-project-fixture.js';

// Cursor's prompt hook has no message for an accepted prompt; its Agent reads
// the receipt from get_collaboration_preferences, as sessionStart tells it to.
export const captureClient = Object.freeze({ sourceApplication: 'cursor', entry: cursorEntry, entryMessage: false });
