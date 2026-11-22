import { sourceLabel } from '../agent-kits/session-clients.js';

// What each connected client actually tells FULI about a segment of work, read
// off its own hook input rather than assumed (rec#147). A work segment records
// the client, its native session, the model and the token usage; where a client
// reports none of a thing, the record says unknown and names the client as the
// reason. FULI never estimates a model or a token count it was not given.
//
// `model`:
//   'actual'    the model that answered, read from the client's own transcript
//   'requested' the model the client asked for; what answered may differ
//               (a fallback, a router), so it is labelled as requested
//   'none'      the client sends no model at all
// `tokens`: 'reported' when FULI can read the client's own usage, else 'none'.
// `session`: 'reported' when the client names its native session to a FULI hook.
//
// One line per client, each verified against the file named beside it:
export const CLIENT_PROVENANCE = Object.freeze({
  // src/agents/claude-code/session-model.js reads message.model of the newest assistant record.
  claude_code: Object.freeze({ session: 'reported', model: 'actual', tokens: 'none' }),
  // src/agents/codex/lifecycle-event.js reads input.model; src/agents/codex/token-usage.js reads the rollout's total_token_usage.
  codex: Object.freeze({ session: 'reported', model: 'requested', tokens: 'reported' }),
  // src/agents/cursor/lifecycle-hook.js reads conversation_id, generation_id and workspace_roots only.
  cursor: Object.freeze({ session: 'reported', model: 'none', tokens: 'none' }),
  // src/agents/opencode/plugin.js and src/agents/dsh/plugin.js send session_id, message_id and cwd only.
  opencode: Object.freeze({ session: 'reported', model: 'none', tokens: 'none' }),
  dsh: Object.freeze({ session: 'reported', model: 'none', tokens: 'none' }),
  // No lifecycle hook of its own: entry is the MCP tool fallback (src/agents/claude-desktop/).
  claude: Object.freeze({ session: 'none', model: 'none', tokens: 'none' }),
  kiro: Object.freeze({ session: 'none', model: 'none', tokens: 'none' }),
  antigravity: Object.freeze({ session: 'none', model: 'none', tokens: 'none' }),
  other: Object.freeze({ session: 'none', model: 'none', tokens: 'none' })
});

const UNKNOWN_CLIENT = CLIENT_PROVENANCE.other;

export function clientProvenance(client) {
  return CLIENT_PROVENANCE[client] ?? UNKNOWN_CLIENT;
}

// Why a segment has no model, in the words a person reads. `client_sends_none`
// is a property of that client; `not_recorded` is a record written before FULI
// kept the model, which is never backfilled with a guess.
const MODEL_UNKNOWN = Object.freeze({
  client_sends_none: client => `${sourceLabel(client)} 不提供模型信息`,
  not_recorded: () => '未知（当时没记）'
});

// The model of one work segment, with where the value came from. A caller
// shows `note` as is; it never falls back to a default model name.
export function modelProvenance(client, model) {
  const known = typeof model === 'string' && model.trim() ? model.trim() : null;
  const reports = clientProvenance(client).model;
  if (known) return { model: known, source: reports === 'actual' ? 'actual' : 'requested', note: null };
  const reason = reports === 'none' ? 'client_sends_none' : 'not_recorded';
  return { model: null, source: 'unknown', reason, note: MODEL_UNKNOWN[reason](client) };
}

// Whether this client can ever supply the token usage of its own work, so a
// usage roll-up can separate "this client reports none" from "none recorded yet".
export function reportsTokenUsage(client) {
  return clientProvenance(client).tokens === 'reported';
}

// The clients that report no model at all, for the one line a usage view shows
// instead of leaving a column blank.
export function clientsWithoutModel() {
  return Object.keys(CLIENT_PROVENANCE).filter(client => CLIENT_PROVENANCE[client].model === 'none');
}
