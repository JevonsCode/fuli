import { claudeCodeWake } from './claude-code/wake.js';
import { codexWake } from './codex/wake.js';

// Clients that can be woken headlessly to answer another Agent, in preference order.
export const WAKE_ADAPTERS = Object.freeze({
  [claudeCodeWake.id]: claudeCodeWake,
  [codexWake.id]: codexWake,
});

export const WAKE_CLIENTS = Object.freeze(Object.keys(WAKE_ADAPTERS));

export function wakeAdapter(client) {
  return Object.hasOwn(WAKE_ADAPTERS, client) ? WAKE_ADAPTERS[client] : null;
}
