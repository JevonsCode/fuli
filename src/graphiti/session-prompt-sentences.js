import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { jsonFormat, updateVersionedJsonFileAtomic } from '../storage/json-format.js';

// The sentence keys of each recent session's earlier prompts (rec#88), so the
// recall can tell the instructions a client repeats on every prompt from the
// task's own words (task-prompt-statement.js). Hashes only: no prompt text,
// no session ID. Bounded: the latest sessions, the latest keys of each.
export const SESSION_PROMPT_SENTENCES_FORMAT = jsonFormat({ store: 'session-prompt-sentences', versions: [1] });
// Its place in a data directory, as the local store list names it.
export const SESSION_PROMPT_SENTENCES_FILE = 'session-prompts/session-prompt-sentences.json';
const MAX_SESSIONS = 32;
const MAX_KEYS = 64;
const KEY = /^[a-f0-9]{32}$/;

export function createSessionPromptSentences({ dataDir, now = Date.now }) {
  const path = join(dataDir, SESSION_PROMPT_SENTENCES_FILE);
  return {
    // The keys earlier prompts of this session had; this prompt's keys are
    // added for the next one. Any failure reads as a session with none.
    exchange(sourceApplication, sessionId, keys) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return new Set();
      const session = contentHash({ purpose: 'session-prompt-sentences-v1', sourceApplication, sessionId }).slice(0, 32);
      let earlier = new Set();
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        updateVersionedJsonFileAtomic(path, SESSION_PROMPT_SENTENCES_FORMAT, current => {
          const sessions = validSessions(current?.sessions);
          earlier = new Set(sessions[session]?.keys ?? []);
          const merged = [...[...earlier].filter(key => !keys.includes(key)), ...keys.filter(key => KEY.test(key))].slice(-MAX_KEYS);
          const kept = Object.entries({ ...sessions, [session]: { at: now(), keys: merged } })
            .sort(([, left], [, right]) => right.at - left.at).slice(0, MAX_SESSIONS);
          return { version: 1, sessions: Object.fromEntries(kept) };
        }, { read: readOrNothing });
      } catch { /* No earlier keys: every sentence counts as the task's own. */ }
      return earlier;
    }
  };
}

function readOrNothing(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

function validSessions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => KEY.test(key) && Number.isFinite(item?.at)
    && Array.isArray(item.keys) && item.keys.length <= MAX_KEYS && item.keys.every(hash => KEY.test(hash))));
}
