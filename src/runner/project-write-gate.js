import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ApplicationError } from '../app/application-error.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const roles = ['owner', 'replica', 'vacant'];
const refused = code => new ApplicationError(code, 'Project writes are paused until ownership is confirmed.', { status: 409 });
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const table = '(project TEXT PRIMARY KEY, role TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, move_id TEXT)';
const same = (a, b) => a?.role === b?.role && a?.generation === b?.generation && a?.state === b?.state && a?.move_id === b?.move_id;

export function gateDirectory(dataDir, spaceId) {
  if (!valid(spaceId)) throw refused('project_scope_unknown');
  return join(dataDir, 'runner', 'project-gates', hash(spaceId));
}

function gatePath(dir, project) {
  if (!valid(project)) throw refused('project_scope_unknown');
  return join(dir, hash(project) + '.sqlite');
}

function localError(error) {
  if ([5,6].includes(error?.errcode)) return refused('project_writes_in_flight');
  return error;
}

// The coordinator holds the index and this project's lock exclusively in one
// rollback-journal transaction. SQLite's super-journal commits both files or
// neither, including after process death. Other projects keep their own locks.
function change(dir, project, create, decide) {
  const file = gatePath(dir, project);
  const index = join(dir, 'index.sqlite');
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if (!existsSync(file) || !existsSync(index)) throw refused('project_gate_missing');
  const db = new DatabaseSync(index);
  try {
    db.exec('PRAGMA busy_timeout=0');
    db.prepare('ATTACH DATABASE ? AS item').run(file);
    for (const name of ['main', 'item']) {
      const mode = db.prepare('PRAGMA ' + name + '.journal_mode').get().journal_mode;
      if (mode !== 'delete') throw refused('project_gate_format');
    }
    db.exec('BEGIN EXCLUSIVE');
    if (create) {
      db.exec('CREATE TABLE IF NOT EXISTS main.gates' + table);
      db.exec('CREATE TABLE IF NOT EXISTS item.gates' + table);
    }
    const prior = db.prepare('SELECT * FROM main.gates WHERE project=?').get(project);
    const copy = db.prepare('SELECT * FROM item.gates WHERE project=?').get(project);
    if (!same(prior, copy) || Boolean(prior) !== Boolean(copy)) throw refused('project_gate_inconsistent');
    const next = decide(prior);
    if (!same(prior, next)) {
      for (const name of ['main','item']) db.prepare('INSERT OR REPLACE INTO ' + name + '.gates VALUES(?,?,?,?,?)')
        .run(project, next.role, next.generation, next.state, next.move_id);
    }
    db.exec('COMMIT');
    return next;
  } catch (error) { throw localError(error); }
  finally { db.close(); }
}

export function initializeProjectGate(dir, project, role, generation) {
  if (!roles.includes(role) || !Number.isSafeInteger(generation) || generation < 1) throw refused('project_gate_invalid');
  return change(dir, project, true, old => {
    if (!old) return { role, generation, state: 'open', move_id: null };
    if (old.role !== role || old.generation !== generation || old.state !== 'open') throw refused('project_generation_changed');
    return old;
  });
}

export function freezeProject(dir, project, { generation, role, moveId }) {
  if (!valid(moveId)) throw refused('project_move_unknown');
  return change(dir, project, false, old => {
    if (!old || old.generation !== generation || old.role !== role) throw refused('project_generation_changed');
    if (old.state === 'closed' && old.move_id === moveId) return old;
    if (old.state !== 'open' || old.move_id === moveId) throw refused('project_move_changed');
    return { ...old, state: 'closed', move_id: moveId };
  });
}

export function finishProjectGate(dir, project, { generation, moveId, role, commit }) {
  if (!valid(moveId) || !roles.includes(role) || typeof commit !== 'boolean' ||
    !Number.isSafeInteger(generation) || generation < 1) throw refused('project_move_unknown');
  const next = generation + Number(commit);
  return change(dir, project, false, old => {
    if (!old || old.move_id !== moveId) throw refused('project_move_changed');
    if (old.state === 'open' && old.role === role && old.generation === next) return old;
    if (old.state !== 'closed' || old.generation !== generation || (!commit && old.role !== role) ||
      (commit && (old.role === 'owner' ? role !== 'replica' : role !== 'owner'))) throw refused('project_generation_changed');
    return { role, generation: next, state: 'open', move_id: moveId };
  });
}

// null means an unresolved write: it must be safe in every project. Known
// writes take sorted project locks and retain them through the business commit.
export function holdProjectWrites(dir, projects, expectedGeneration) {
  const held = [];
  const release = () => { while (held.length) held.pop().close(); };
  try {
    for (const project of projects == null ? [null] : [...new Set(projects)].sort()) {
      const file = project == null ? join(dir, 'index.sqlite') : gatePath(dir, project);
      if (!existsSync(file)) throw refused('project_gate_missing');
      const db = new DatabaseSync(file, { readOnly: true });
      held.push(db);
      db.exec('PRAGMA busy_timeout=0');
      db.exec('BEGIN');
      if (project == null) {
        if (db.prepare("SELECT 1 FROM gates WHERE state<>'open' OR role<>'owner' LIMIT 1").get()) throw refused('project_scope_unknown');
      } else {
        const gate = db.prepare('SELECT * FROM gates WHERE project=?').get(project);
        if (!gate || gate.state !== 'open' || gate.role !== 'owner') throw refused('project_write_blocked');
        if (expectedGeneration != null && gate.generation !== expectedGeneration) throw refused('project_generation_changed');
      }
    }
    return release;
  } catch (error) { release(); throw localError(error); }
}

// Paired deployments initialize the index before activating the descriptor.
// A surviving descriptor with a missing index stays closed following recovery.
export function localWriteAdmission(dataDir, spaceId, projects, generation) {
  const directory = gateDirectory(dataDir, spaceId);
  if (!existsSync(directory) && !existsSync(join(dataDir, 'runner', 'project-registry.json'))) return () => {};
  return holdProjectWrites(directory, projects, generation);
}

// Keep a read transaction on the ownership index for the entire backup or
// restore. An older dump cannot reintroduce a retired generation.
export function holdBackupOwnership(dataDir, restoring, saved) {
  const descriptor = join(dataDir, 'runner', 'project-registry.json');
  if (!existsSync(descriptor)) {
    if (saved || existsSync(join(dataDir, 'runner', 'project-gates'))) throw refused('project_gate_missing');
    return null;
  }
  const { spaceId, device, authority, version } = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (version !== 1 || ![device, authority].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    throw refused('project_gate_inconsistent');
  }
  const file = join(gateDirectory(dataDir, spaceId), 'index.sqlite');
  if (!existsSync(file)) throw refused('project_gate_missing');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const rows = db.prepare('SELECT project,role,generation,state,move_id FROM gates ORDER BY project').all();
    if (rows.some(row => row.state !== 'open')) throw refused('project_move_in_progress');
    const digest = hash(JSON.stringify([version, spaceId, device, authority, rows]));
    if (restoring && digest !== saved) throw refused('backup_project_generation_changed');
    return { digest, release: () => db.close() };
  } catch (error) { db.close(); throw localError(error); }
}
