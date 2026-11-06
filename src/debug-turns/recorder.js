import { dirname } from 'node:path';

import { buildDebugRecord, redactDebugText } from './record.js';
import { debugTurnStore } from './store.js';
import { debugPromptDigest, readDebugTranscript } from './transcript-reader.js';
import { isDebugPrompt } from './trigger.js';
import { fuliMcpSurface } from './fuli-surface.js';

// The one call an Agent's lifecycle hook makes for #fulidebug (Jevons 11-04),
// after its output is final, a failed hook included: that turn is the one worth
// reading. It only reads what the hook decided and writes local files. A marked
// prompt's entry frame is kept until a Stop, which builds the record from it,
// the Stop frame and the host's transcript (adapter: the Agent's transcript port,
// or null for a host without one). A message queued mid-turn leaves it in place.
// Recording never changes or fails the turn: an error is logged and the hook
// goes on.
export async function recordDebugTurn({ runtimeConfigPath, sourceApplication, event, input, output, adapter = null },
  { surface = fuliMcpSurface, log = defaultLog, now = () => new Date() } = {}) {
  try {
    const sessionId = input?.session_id;
    if (!runtimeConfigPath || typeof sessionId !== 'string' || !sessionId) return;
    const store = debugTurnStore(dirname(runtimeConfigPath));
    // Only a marked turn pays for this: every other turn leaves here untouched.
    const frame = () => ({ event, text: redactDebugText(JSON.stringify(output ?? null)) });
    if (event === 'UserPromptSubmit') {
      if (!isDebugPrompt(input.prompt)) return;
      store.pending.write(sourceApplication, sessionId, { prompt: redactDebugText(input.prompt),
        promptDigest: debugPromptDigest(input.prompt), frames: [frame()] });
      return;
    }
    if (event !== 'Stop') return;
    const pending = store.pending.read(sourceApplication, sessionId);
    if (!pending) return;
    try {
      const [mcp, transcript] = await Promise.all([
        surface().catch(() => null),
        readDebugTranscript(input.transcript_path, sessionId, adapter, pending.promptDigest)
      ]);
      store.write(buildDebugRecord({ sourceApplication, sessionId, prompt: pending.prompt,
        frames: [...pending.frames, frame()], surface: mcp, transcript,
        lastAssistantMessage: input.last_assistant_message ?? null }, { now }));
    } finally {
      store.pending.remove(sourceApplication, sessionId);
    }
  } catch (error) {
    // No prompt, path or message: only what kind of failure it was.
    log(`FULI: this #fulidebug turn was not recorded (${error?.code ?? error?.name ?? 'error'}).`);
  }
}

function defaultLog(line) {
  process.stderr.write(`${line}\n`);
}
