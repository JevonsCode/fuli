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
// The refusals a resubmission can get past: a token the Provider does not know
// for this client (another client's, superseded or expired) or may not use.
// Any other refusal is about the content, which a resubmission sends unchanged.
const RESUBMITTABLE_STATUSES = new Set([403, 404]);
const NOT_SAVED_GUIDANCE = 'FULI did not save this checkpoint: provider_message says why. Its input is kept on this '
  + 'computer as unsaved_checkpoint_id. Tell the person in one line that this task\'s knowledge is not saved in FULI '
  + 'yet. Fix what provider_message names (for a token from another client, get a token through this connection), '
  + 'then call checkpoint_task_knowledge with that taskContextToken and unsavedCheckpointId; the kept input is sent.';

export function unsavedCheckpointRecords(dataDir, { now = () => new Date().toISOString() } = {}) {
  const pathOf = id => join(dataDir, UNSAVED_CHECKPOINT_DIRECTORY, `${id}.json`);
  return {
    idOf: input => sha256Bytes(canonicalJson(input, { omitUndefined: true })).slice(0, 32),
    // Only the task's content is kept: a resubmission brings its own token,
    // and the MCP host's client and session come from that call.
    keep(input, contentFields, error) {
      const id = this.idOf(input);
      const kept = Object.fromEntries(contentFields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
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
// contentFields: the checkpoint's own arguments (its definition's), never the
// host fields the MCP layer adds. Without a store (a test app) a refusal fails
// and an outage asks for the same input, as before.
export async function checkpointKeepingUnsaved(records, { unsavedCheckpointId, ...input }, checkpoint, contentFields) {
  const resubmitting = unsavedCheckpointId !== undefined;
  const kept = resubmitting ? records?.read(unsavedCheckpointId) : null;
  if (resubmitting && !kept) {
    throw new InvalidInputError('unsavedCheckpointId names no unsaved checkpoint kept on this computer');
  }
  // A kept input replaces this call's disposition, reason and content: it is what the task produced.
  const sent = kept ? { ...withoutContent(input, contentFields), ...kept.input, taskContextToken: input.taskContextToken } : input;
  let result;
  try {
    result = await checkpoint(sent);
  } catch (error) {
    const outage = isProviderOutage(error);
    const keepable = error instanceof ProviderRequestError && (outage || RESUBMITTABLE_STATUSES.has(error.status));
    if (!keepable || (!records && !outage)) throw error;
    const id = kept?.id ?? keepQuietly(records, sent, contentFields, error);
    if (outage) return { ...checkpointIncomplete(error), ...(id ? { unsaved_checkpoint_id: id } : {}) };
    if (!id) throw error;
    return { status: 'checkpoint_not_saved', reason: error.code, provider_message: utf8Preview(String(error.message), MESSAGE_BYTES),
      checkpoint_required: true, unsaved_checkpoint_id: id, guidance: NOT_SAVED_GUIDANCE };
  }
  // The checkpoint is saved; a copy left behind only means a later cleanup.
  try { records?.remove(kept?.id ?? records.idOf(sent)); } catch { /* the saved result still stands */ }
  return kept ? { ...result, resubmitted_unsaved_checkpoint_id: kept.id } : result;
}

// A kept copy that cannot be written leaves the failure as it was.
function keepQuietly(records, input, contentFields, error) {
  try { return records?.keep(input, contentFields, error) ?? null; } catch { return null; }
}

function withoutContent(input, contentFields) {
  return Object.fromEntries(Object.entries(input).filter(([field]) => !contentFields.includes(field)));
}
