import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { activeAgentHostSession } from '../app/agent-request-context.js';
import { sha256Bytes } from '../security/digest.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { utf8Preview } from '../text/utf8-preview.js';

// The one exception to task entry never keeping the person's prompt (rec#80):
// a session's transcript is saved only when its turn ends, so the words an FLA
// relays as the person's decision in the same turn ("好，验收") could not be
// checked. A hook's task entry, which carries the host's own prompt and never
// an Agent's argument, keeps that prompt here, on this computer only, for
// run_delegated_action's check and nothing else: one record per session, so
// the next entry replaces it, and the task's checkpoint removes it. No tool
// output, entry frame, receipt or log reads it.
export const ENTRY_PROMPT_FORMAT = jsonFormat({ store: 'entry-prompts', versions: [1] });
const RECORD_VERSION = 1;
const PROMPT_BYTES = 8 * 1024;

export function entryPromptRecords(dataDir, { now = () => new Date().toISOString() } = {}) {
  const pathOf = (task) =>
    join(dataDir, 'entry-prompts', `${sha256Bytes(`${task.sourceApplication}\0${task.sessionId}`)}.json`);
  const stored = (task) => {
    let record;
    try { record = readJsonFile(pathOf(task), null); } catch { return null; }
    return record?.version === RECORD_VERSION && record.token === task.token && typeof record.prompt === 'string'
      ? record : null;
  };
  return {
    // A task's entry: keeps the prompt of a hook's entry, and for any other
    // entry drops what the session's earlier task kept.
    enter(task, prompt) {
      const text = typeof prompt === 'string' ? prompt.trim() : '';
      if (activeAgentHostSession() !== undefined || !text) {
        rmSync(pathOf(task), { force: true });
        return;
      }
      writeVersionedJsonFileAtomic(pathOf(task), { version: RECORD_VERSION, token: task.token,
        prompt: utf8Preview(text, PROMPT_BYTES), keptAt: now() }, ENTRY_PROMPT_FORMAT);
    },

    // The prompt that began this task, while it is the session's kept one.
    read(task) {
      const record = stored(task);
      return record ? { prompt: record.prompt, keptAt: record.keptAt ?? null } : null;
    },

    checkpointed(task) {
      if (stored(task)) rmSync(pathOf(task), { force: true });
    }
  };
}
