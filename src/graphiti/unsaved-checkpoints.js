import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { sha256Bytes } from '../security/digest.js';
import { InvalidInputError } from '../app/application-error.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { checkpointIncomplete } from './checkpoint-provider-outage.js';
import { isProviderOutage } from './provider-outage.js';
import { ProviderRequestError } from './provider-client.js';
import { utf8Preview } from '../text/utf8-preview.js';

// rec#110 item 8: a checkpoint FULI's graph service did not save (an outage,
// or a refusal such as a token from another client) lost what the Agent sent
// once its session moved on. Its input is kept here, on this computer only,
// one file per checkpoint, until a later call resubmits it with
// unsavedCheckpointId and FULI saves it. Nothing else reads these files. A
// kept input's ID is its content hash with its token, so a same-input retry
// keeps one file and its success removes it.
export const UNSAVED_CHECKPOINT_FORMAT = jsonFormat({ store: 'unsaved-checkpoints', versions: [1] });
export const UNSAVED_CHECKPOINT_DIRECTORY = 'unsaved-checkpoints';
const RECORD_VERSION = 1;
const MESSAGE_BYTES = 480;
const ID = /^[0-9a-f]{32}$/u;
const NOT_SAVED_GUIDANCE = 'FULI did not save this checkpoint: provider_message says why. Its input is kept on this '
  + 'computer as unsaved_checkpoint_id. Tell the person in one line that this task\'s knowledge is not saved in FULI '
  + 'yet. Fix what provider_message names (for a token from another client, get a token through this connection), '
  + 'then call checkpoint_task_knowledge with that taskContextToken and unsavedCheckpointId; the kept input is sent.';

export function unsavedCheckpointRecords(dataDir, { now = () => new Date().toISOString() } = {}) {
  const pathOf = id => join(dataDir, UNSAVED_CHECKPOINT_DIRECTORY, `${id}.json`);
  return {
    idOf: input => sha256Bytes(canonicalJson(input, { omitUndefined: true })).slice(0, 32),
    // The token is not kept: a resubmission brings a token of its own.
    keep(input, error) {
      const id = this.idOf(input);
      const { taskContextToken, ...kept } = input;
      writeVersionedJsonFileAtomic(pathOf(id), { version: RECORD_VERSION, id, keptAt: now(),
        reason: { code: error.code ?? 'provider_error', status: error.status ?? null }, input: kept },
      UNSAVED_CHECKPOINT_FORMAT);
      return id;
    },
    read(id) {
      if (typeof id !== 'string' || !ID.test(id)) return null;
      let record;
      try { record = readJsonFile(pathOf(id), null); } catch { return null; }
      return record?.version === RECORD_VERSION && record.id === id ? record : null;
    },
    remove(id) { rmSync(pathOf(id), { force: true }); }
  };
}

// The checkpoint call with its input kept when the graph service does not save
// it, and a kept input sent again when unsavedCheckpointId names one.
// Without a store (a test app) a refusal fails and an outage asks for the same input, as before.
export async function checkpointKeepingUnsaved(records, { unsavedCheckpointId, ...input }, checkpoint) {
  const resubmitting = unsavedCheckpointId !== undefined;
  const kept = resubmitting ? records?.read(unsavedCheckpointId) : null;
  if (resubmitting && !kept) {
    throw new InvalidInputError('unsavedCheckpointId names no unsaved checkpoint kept on this computer');
  }
  // A kept input replaces this call's disposition, reason and content: it is what the task produced.
  const sent = kept ? { ...kept.input, taskContextToken: input.taskContextToken } : input;
  let result;
  try {
    result = await checkpoint(sent);
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || (!records && !isProviderOutage(error))) throw error;
    const id = records ? kept?.id ?? records.keep(sent, error) : null;
    if (isProviderOutage(error)) return { ...checkpointIncomplete(error), ...(id ? { unsaved_checkpoint_id: id } : {}) };
    return { status: 'checkpoint_not_saved', reason: error.code, provider_message: utf8Preview(String(error.message), MESSAGE_BYTES),
      checkpoint_required: true, unsaved_checkpoint_id: id, guidance: NOT_SAVED_GUIDANCE };
  }
  records?.remove(kept?.id ?? records.idOf(sent));
  return kept ? { ...result, resubmitted_unsaved_checkpoint_id: kept.id } : result;
}
