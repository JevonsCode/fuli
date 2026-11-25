import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { holdFormattedSnapshot } from '../../packages/roundtable/src/storage/database-format.js';
import { writesEntryId } from './global-writes-outbox.js';
import { PROJECT_MOVES_FILE, PROJECT_MOVES_FORMAT, moveError } from './move-store.js';
import { GLOBAL_WRITES_ENTRY } from './protocol.js';
import { readIssued } from './task-issuer.js';

function add(keys, kind, value) {
  if (typeof value === 'string' && value) keys.add(createHash('sha256').update(JSON.stringify([kind, value])).digest('hex'));
}

export function sealWorkKeys(move, text) {
  const keys = new Set();
  add(keys, 'project', move.project);
  for (const node of JSON.parse(text).envelope.nodes) {
    const props = node.properties;
    if (node.labels.includes('FuliTaskContext')) {
      add(keys, 'task', props.token);
      add(keys, 'entry', writesEntryId('global', props.token + ':global'));
      const record = props.record_json ? JSON.parse(props.record_json) : {};
      add(keys, 'session', record.session_id);
    }
    if (node.labels.includes('FuliProjectAgentRecruitment')) add(keys, 'recruit', props.recruitment_id);
  }
  return keys;
}

export function entryWorkKeys({ id, input, tool, sessionId, originTask }, includeSession) {
  const keys = new Set();
  const token = originTask ?? input?.taskContextToken;
  add(keys, 'task', readIssued(token)?.token ?? token);
  if (includeSession) add(keys, 'project', input?.personalProjectId);
  if (tool === GLOBAL_WRITES_ENTRY) {
    add(keys, 'entry', id.replace(/(?:\.\d+)+$/, ''));
    for (const op of input?.ops ?? []) {
      add(keys, 'recruit', op.input?.recruitmentId);
      add(keys, 'task', op.input?.taskId);
    }
    // Old split checkpoint entries used an opaque id and carried no task token.
    if (includeSession && !token && !input?.ops?.some(op => op.input?.recruitmentId || op.input?.taskId)) {
      add(keys, 'session', sessionId);
    }
  }
  return keys;
}

export function blockedMoveWork(dataDir, entry) {
  if (!dataDir) return null;
  const file = join(dataDir, PROJECT_MOVES_FILE);
  if (!existsSync(file)) return null;
  const db = holdFormattedSnapshot(file, PROJECT_MOVES_FORMAT);
  try {
    const exact = entryWorkKeys(entry, false);
    const frozen = db.prepare(`SELECT p.step FROM move_outbox_keys k JOIN move_participants p USING(space,project,move_id)
      WHERE k.key_hash=? AND p.step IN ('sealed','demoted','routed','forwarded') AND p.gate_role='owner'
      AND (p.step<>'forwarded' OR ?=1) ORDER BY p.generation DESC LIMIT 1`);
    for (const key of entryWorkKeys(entry, true)) {
      const row = frozen.get(key, Number(exact.has(key)));
      if (row) return row.step === 'forwarded' ? 'project_task_moved' : 'project_move_frozen';
    }
    return null;
  } finally { db.close(); }
}

export function checkPendingMoveWork(db, keys, heldBecause) {
  for (const row of db.prepare("SELECT id,tool,input,session_id,state,last_error FROM outbox WHERE state<>'delivered'").iterate()) {
    if (row.state !== 'queued' && !heldBecause(row.last_error)) continue;
    const entry = { ...row, input: JSON.parse(row.input), sessionId: row.session_id };
    if ([...entryWorkKeys(entry, true)].some(key => keys.has(key))) throw moveError('project_outbox_pending');
  }
}
