import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { ApplicationError } from '../app/application-error.js';
import { grantScope } from './scope-grants.js';

export const PROJECT_MOVES_FILE = 'runner/project-moves.sqlite';
export const PROJECT_MOVES_FORMAT = sqliteFormat({
  store: 'project-moves',
  schema: `CREATE TABLE IF NOT EXISTS move_requests(
    space TEXT NOT NULL, project TEXT NOT NULL, move_id TEXT NOT NULL, source TEXT NOT NULL,
    target TEXT NOT NULL, generation INTEGER NOT NULL, pairing TEXT NOT NULL, reason TEXT NOT NULL,
    step TEXT NOT NULL, seal TEXT, position INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(space,project,move_id));
    CREATE UNIQUE INDEX IF NOT EXISTS move_one_request ON move_requests(space,project)
      WHERE step NOT IN ('done','aborted');
    CREATE TABLE IF NOT EXISTS move_participants(
    space TEXT NOT NULL, project TEXT NOT NULL, move_id TEXT NOT NULL, source TEXT NOT NULL,
    target TEXT NOT NULL, generation INTEGER NOT NULL, pairing TEXT NOT NULL, gate_role TEXT NOT NULL,
    step TEXT NOT NULL, allowed_action TEXT, graph_digest TEXT, baseline_digest TEXT, board_digest TEXT,
    board_baseline TEXT, PRIMARY KEY(space,project,move_id));
    CREATE UNIQUE INDEX IF NOT EXISTS move_one_participant ON move_participants(space,project)
      WHERE step NOT IN ('forwarded','activated','aborted');
    CREATE TABLE IF NOT EXISTS move_task_history(token_hash TEXT NOT NULL, space TEXT NOT NULL, project TEXT NOT NULL,
      move_id TEXT NOT NULL, PRIMARY KEY(token_hash,space,project,move_id));
    CREATE TABLE IF NOT EXISTS move_outbox_keys(key_hash TEXT NOT NULL, space TEXT NOT NULL, project TEXT NOT NULL,
      move_id TEXT NOT NULL, PRIMARY KEY(key_hash,space,project,move_id));
    CREATE TABLE IF NOT EXISTS move_files(
    space TEXT NOT NULL, project TEXT NOT NULL, move_id TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL,
    bytes INTEGER NOT NULL, PRIMARY KEY(space,project,move_id,kind));
    CREATE TABLE IF NOT EXISTS move_chunks(
    space TEXT NOT NULL, project TEXT NOT NULL, move_id TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL,
    data BLOB NOT NULL, PRIMARY KEY(space,project,move_id,kind,position));`
});

export const moveKey = move => [move.space, move.project, move.move_id];
export function moveError(code) { return new ApplicationError(code, 'Project transfer needs attention.', { status: 409 }); }
export const digestValue = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function validMove(move) {
  return move && typeof move.space === 'string' && move.space.length > 0 && move.space.length <= 128 &&
    typeof move.project === 'string' && grantScope('project:' + move.project) === 'project:' + move.project &&
    move.project.length <= 128 && typeof move.move_id === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(move.move_id) &&
    digestValue(move.source) && digestValue(move.target) && move.source !== move.target &&
    typeof move.pairing === 'string' && move.pairing.length > 0 && move.pairing.length <= 128 &&
    Number.isSafeInteger(move.generation) && move.generation >= 1;
}
export const sameMove = (a, b) => validMove(a) && validMove(b) &&
  ['space','project','move_id','source','target','generation','pairing'].every(field => a[field] === b[field]);

export class MoveStore {
  constructor(path) { this.db = openFormattedDatabase(path, PROJECT_MOVES_FORMAT); }
  close() { this.db.close(); }
  request(move) {
    return this.db.prepare('SELECT * FROM move_requests WHERE space=? AND project=? AND move_id=?').get(...moveKey(move));
  }
  participant(move) {
    return this.db.prepare('SELECT * FROM move_participants WHERE space=? AND project=? AND move_id=?').get(...moveKey(move));
  }
  begin(move, reason) {
    if (!validMove(move) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw moveError('move_invalid');
    return immediateTransaction(this.db, () => {
      const previous = this.request(move);
      if (previous) {
        if (!sameMove(previous, move) || previous.reason !== reason) throw moveError('move_changed');
        return previous;
      }
      if (this.db.prepare("SELECT 1 FROM move_requests WHERE space=? AND project=? AND step NOT IN ('done','aborted')")
        .get(move.space, move.project)) throw moveError('move_in_progress');
      this.db.prepare(`INSERT INTO move_requests(space,project,move_id,source,target,generation,pairing,reason,step,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'requested',?)`).run(...moveKey(move), move.source, move.target, move.generation,
          move.pairing, reason, new Date().toISOString());
      return this.request(move);
    });
  }
  enlist(move, role) {
    if (!validMove(move) || !['owner','replica','vacant'].includes(role)) throw moveError('move_invalid');
    return immediateTransaction(this.db, () => {
      const row = this.participant(move);
      if (row) {
        if (!sameMove(row, move) || row.gate_role !== role) throw moveError('move_changed');
        return row;
      }
      this.db.prepare(`INSERT INTO move_participants(space,project,move_id,source,target,generation,pairing,gate_role,step)
        VALUES(?,?,?,?,?,?,?,?,'requested')`).run(...moveKey(move), move.source, move.target, move.generation, move.pairing, role);
      return this.participant(move);
    });
  }
  advance(move, expected, step, seal = null) {
    this.db.prepare(`UPDATE move_requests SET step=?, seal=coalesce(?,seal), last_error=NULL, updated_at=?
      WHERE space=? AND project=? AND move_id=? AND step=?`)
      .run(step, seal && JSON.stringify(seal), new Date().toISOString(), ...moveKey(move), expected);
    return this.request(move);
  }
  pending(space) {
    return this.db.prepare("SELECT * FROM move_requests WHERE space=? AND step NOT IN ('done','aborted') ORDER BY updated_at LIMIT 32").all(space);
  }
}
