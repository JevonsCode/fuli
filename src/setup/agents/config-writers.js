import { claudeCodeStatus, connectClaudeCode, disconnectClaudeCode } from '../claude-code-config.js';
import { codexStatus, connectCodex, disconnectCodex } from '../codex-config.js';
import { connectCursor, cursorStatus, disconnectCursor } from '../cursor-config.js';

// The fixed code set a descriptor pack's `configWriter` chooses from (rec#18
// D-10). A writer owns one client file format: it renders the pack's data into
// that format and keeps every unrelated entry. Disconnect recognises FULI's
// entries by fixed markers, never by pack data, so any earlier connection can
// be removed. A new format is a code release, not a pack.
export const CONFIG_WRITERS = Object.freeze({
  'claude-code-settings': Object.freeze({ connect: connectClaudeCode, disconnect: disconnectClaudeCode, status: claudeCodeStatus }),
  'codex-toml': Object.freeze({ connect: connectCodex, disconnect: disconnectCodex, status: codexStatus }),
  'cursor-hooks': Object.freeze({ connect: connectCursor, disconnect: disconnectCursor, status: cursorStatus })
});
