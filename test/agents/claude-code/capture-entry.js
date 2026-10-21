// How a Claude Code turn enters FULI, for the capture parity check of every
// lifecycle client (test/capture-client-parity.test.js, rec#5 C4-5).
import { claudeEntry } from '../../fixtures/capture-project-fixture.js';

// entryMessage: the hook shows the person a line at entry (systemMessage).
export const captureClient = Object.freeze({ sourceApplication: 'claude_code', entry: claudeEntry, entryMessage: true });
