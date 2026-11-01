import { connectClaudeCode, disconnectClaudeCode } from '../claude-code-config.js';
import { connectCodex, disconnectCodex } from '../codex-config.js';
import { connectCursor, disconnectCursor } from '../cursor-config.js';
import { connectOpenCode, disconnectOpenCode, openCodeTarget } from './opencode/config-writer.js';

// The fixed code set a descriptor pack's `configWriter` chooses from (rec#18
// D-10). A writer owns one client file format: it renders the pack's data into
// that format and keeps every unrelated entry. Disconnect recognises FULI's
// entries by fixed markers, never by pack data, so any earlier connection can
// be removed. A new format is a code release, not a pack. `target`, when a
// writer has one, refines where it edits for a format that chooses between files.
export const CONFIG_WRITERS = Object.freeze({
  'claude-code-settings': Object.freeze({ connect: connectClaudeCode, disconnect: disconnectClaudeCode }),
  'codex-toml': Object.freeze({ connect: connectCodex, disconnect: disconnectCodex }),
  'cursor-hooks': Object.freeze({ connect: connectCursor, disconnect: disconnectCursor }),
  'opencode-plugin': Object.freeze({ connect: connectOpenCode, disconnect: disconnectOpenCode, target: openCodeTarget })
});
