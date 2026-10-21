import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// The only FULI operations that state a turn belongs to a task (rec#15). A
// read, a refresh, a search or any automatic hook call naming the task's token
// does not. Claude Code names a tool of the MCP server setup registers as
// "fuli" (src/setup/claude-code-config.js) mcp__fuli__<tool>.
const EXPLICIT_TASK_CONTINUATIONS = Object.freeze(['checkpoint_task_knowledge']);
const CONTINUATION_TOOLS = new Set(EXPLICIT_TASK_CONTINUATIONS.map(name => `mcp__fuli__${name}`));
// One turn of native history read for evidence; a longer turn stays unresolved.
const MAX_TURN_BYTES = 16 * 1024 * 1024;

// Whether, after `from` and in this main session, the model called an explicit
// continuation with exactly this task's token and the host recorded its result
// as a success. The call itself must be in the turn: a result of an earlier
// turn's call written late does not count. Anything unreadable is no evidence.
export function explicitlyContinuedInTurn(transcriptPath, sessionId, token, from) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || typeof token !== 'string' || !token) return false;
  let text;
  try { text = readFrom(transcriptPath, from); } catch { return false; }
  if (!text) return false;
  const calls = new Set();
  for (const line of text.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.sessionId !== sessionId || (record.isSidechain != null && record.isSidechain !== false)) continue;
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const block of blocks) {
      if (record.type === 'assistant' && block?.type === 'tool_use' && CONTINUATION_TOOLS.has(block.name)
          && block.input?.taskContextToken === token && typeof block.id === 'string') calls.add(block.id);
      if (record.type === 'user' && block?.type === 'tool_result' && calls.has(block.tool_use_id)
          && block.is_error !== true) return true;
    }
  }
  return false;
}

// The complete lines written after `from`; a line `from` cuts is dropped.
function readFrom(path, from) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    if (size <= from) return '';
    if (size - from > MAX_TURN_BYTES) return null;
    const start = Math.max(0, from - 1);
    const buffer = Buffer.alloc(size - start);
    if (readSync(descriptor, buffer, 0, buffer.length, start) !== buffer.length) return null;
    // Keep a line only if it begins at or after `from`.
    const cut = from === 0 ? -1 : buffer.indexOf(10);
    return cut === -1 && from > 0 ? '' : buffer.subarray(cut + 1).toString('utf8');
  } finally { closeSync(descriptor); }
}
