// Which model FULI reads from each connected client for a segment of work,
// taken from its own hook code rather than assumed (rec#147). FULI never
// estimates a model it was not given.
//
//   'actual'    the model that answered, read from the client's own transcript
//   'requested' the model the client asked for; what answered may differ
//               (a fallback, a router), so it is labelled as requested
//
// A client missing here is one whose FULI hook reads no model. That says what
// FULI reads, not what the client offers: whether Cursor, OpenCode or another
// client could supply a model is not verified, so its reason is `not_read`,
// never "the client reports none". Token usage likewise: FULI reads it from
// Codex alone (src/agents/codex/token-usage.js); Claude Code's transcript
// carries message.usage that FULI does not read yet; no work segment stores it.
const MODEL_READ = Object.freeze({
  // src/agents/claude-code/session-model.js reads message.model of the newest assistant record.
  claude_code: 'actual',
  // src/agents/codex/lifecycle-event.js reads input.model of the prompt hook.
  codex: 'requested'
});

// The model of one work segment, with where the value came from. It never
// falls back to a default model name. `reason` says why an unknown one is
// unknown:
//   client_not_recorded  the segment does not say which client did the work
//                        (a record older than graph 22, or a generic client)
//   not_read             FULI reads no model from this client
//   not_recorded         FULI reads one from this client but this segment has
//                        none: a record from before FULI kept it, or a first
//                        turn whose transcript had no answer yet
// Only the reason travels, never a rendered sentence: every surface shows it
// in its own interface language (Jevons 2026-11-18: 该展示成英文就英文，
// 该映射成中文就中文), so no zh/en string is stored or passed around.
export function modelProvenance(client, model) {
  const known = typeof model === 'string' && model.trim() ? model.trim() : null;
  const read = MODEL_READ[client] ?? null;
  if (known) return { model: known, source: read === 'actual' ? 'actual' : 'requested', reason: null };
  const reason = !client || client === 'other' ? 'client_not_recorded' : read ? 'not_recorded' : 'not_read';
  return { model: null, source: 'unknown', reason };
}
