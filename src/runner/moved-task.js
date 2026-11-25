import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { holdFormattedSnapshot } from '../../packages/roundtable/src/storage/database-format.js';
import { moveError, PROJECT_MOVES_FILE, PROJECT_MOVES_FORMAT } from './move-store.js';
import { localRegistryDescriptor } from './project-creation.js';
import { readIssued } from './task-issuer.js';

const taskHash = token => createHash('sha256').update(token).digest('hex');

export function rememberMoveTasks(db, move, text) {
  const records = JSON.parse(text)?.envelope?.nodes;
  if (!Array.isArray(records)) throw moveError('move_file_invalid');
  const add = db.prepare('INSERT OR IGNORE INTO move_task_history VALUES(?,?,?,?)');
  for (const record of records) {
    if (!record.labels?.includes('FuliTaskContext')) continue;
    const token = record.properties?.token;
    if (typeof token !== 'string' || !token || record.properties.personal_project_id !== move.project) throw moveError('move_file_invalid');
    add.run(taskHash(token), move.space, move.project, move.move_id);
  }
}

export function movedTask(dataDir, task) {
  if (!dataDir || typeof task !== 'string' || !task) return null;
  const file = join(dataDir, PROJECT_MOVES_FILE);
  if (!existsSync(file)) return null;
  const db = holdFormattedSnapshot(file, PROJECT_MOVES_FORMAT);
  try {
    const token = readIssued(task)?.token ?? task;
    const history = db.prepare(`SELECT p.space,p.project,p.source,p.target,p.gate_role,p.generation+1 AS generation,
      EXISTS(SELECT 1 FROM move_requests r WHERE r.space=p.space AND r.project=p.project AND r.move_id=p.move_id
        AND r.source=p.source AND r.target=p.target AND r.pairing=p.pairing) AS coordinator
      FROM move_task_history h JOIN move_participants p USING(space,project,move_id) WHERE h.token_hash=?
      AND p.step IN ('promoted','installed','routed','activated','demoted','forwarded')
      ORDER BY p.generation DESC`).all(taskHash(token));
    if (!history.length) return null;
    // A retired token must stay retired after a space or pairing change.
    // Give details only for a transfer made in the active local installation.
    const registry = localRegistryDescriptor(dataDir);
    const row = history.find(move => {
      const here = move.gate_role === 'owner' ? move.source : move.target;
      const peer = here === move.source ? move.target : move.source;
      return registry?.spaceId === move.space && registry.device === here &&
        registry.authority === (move.coordinator ? here : peer);
    });
    return row ? { project: row.project, target: row.target, generation: row.generation } : {};
  } finally { db.close(); }
}
