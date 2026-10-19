import { judgmentClient as claudeCode } from './claude-code/judgment.js';
import { judgmentClient as codex } from './codex/judgment.js';

// Clients that can run a bounded judgment, keyed like the wake adapters.
const JUDGMENT_CLIENTS = Object.freeze({ claude_code: claudeCode, codex });

export function judgmentArgs(client, options) {
  const entry = Object.hasOwn(JUDGMENT_CLIENTS, client) ? JUDGMENT_CLIENTS[client] : null;
  if (!entry) throw new TypeError(`Unsupported judgment client: ${client}`);
  return entry.args(options);
}
