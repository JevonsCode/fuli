import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from '../../packages/roundtable/src/storage/database-format.js';
import { formatBackupPath } from '../../packages/roundtable/src/storage/format-backup-names.js';
import { ApplicationError } from '../app/application-error.js';

const ownershipStores = new Set([
  'runner/host.sqlite', 'runner/runner.sqlite', 'runner/routes.sqlite',
  'runner/project-moves.sqlite', 'runner/owner-operations.sqlite'
]);
const hostOwnership = ['project_owners', 'project_permits', 'project_claims', 'owner_moves', 'owner_inventory'];
const board = 'employees/data/jefa/board.sqlite';
function mismatch() {
  throw new ApplicationError('restore_project_control_changed',
    'This backup would replace project ownership, transfer history or a protected board. 这份备份会覆盖项目归属、迁移记录或受保护的看板。', { status: 409 });
}

// Both files are local SQLite stores opened read-only under whole-directory
// maintenance. Compare protected contents, including immutable board history.
// Rows are streamed in primary-key order; no data or backup paths are logged.
function snapshot(path, selected, protectedProjects, space) {
  const db = openReadOnly(path);
  try {
    db.exec('BEGIN');
    const hash = createHash('sha256');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fuli_format_%' ORDER BY name").all();
    for (const { name } of tables) {
      if (selected && !selected.includes(name)) continue;
      if (!/^[a-z][a-z0-9_]*$/.test(name)) mismatch();
      const fields = db.prepare('SELECT name,pk FROM pragma_table_info(?) ORDER BY cid').all(name);
      if (!fields.every(field => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field.name))) mismatch();
      const keys = fields.filter(f => f.pk).sort((a,b) => a.pk - b.pk).map(f => '"' + f.name + '"').join(',') || 'rowid';
      const perProject = protectedProjects !== null;
      if (perProject && !['space_id','project_id'].every(key => fields.some(f => f.name === key))) mismatch();
      const rows = db.prepare('SELECT * FROM "' + name + '"' + (perProject ? ' WHERE space_id=? AND project_id IN (SELECT value FROM json_each(?))' : '') +
        ' ORDER BY ' + keys);
      rows.setReadBigInts(true);
      const args = perProject ? [space, JSON.stringify(protectedProjects)] : [];
      for (const row of rows.iterate(...args)) {
        const values = fields.map(f => { const value = row[f.name]; return typeof value === 'bigint' ? ['integer', value.toString()] :
          value instanceof Uint8Array ? ['blob', Buffer.from(value).toString('base64')] : value; });
        hash.update(JSON.stringify([name, fields.map(f => f.name), values]) + '\n');
      }
    }
    return hash.digest('hex');
  } finally { db.close(); }
}

export function checkStoreRestore(dataDir, label, backupRef, ownership) {
  if (!label) return;
  if (['runner/project-installation.sqlite', 'runner/project-registry.json'].includes(label)) mismatch();
  const path = join(dataDir, label);
  const backup = typeof backupRef === 'string' && formatBackupPath(path, backupRef);
  if (!ownership) {
    // An authority can record project generations before enrolling its own graph.
    if (label === 'runner/host.sqlite' && backup && existsSync(path) &&
      snapshot(path, hostOwnership, null) !== snapshot(backup, hostOwnership, null)) mismatch();
    return;
  }
  const gates = label.startsWith('runner/project-gates/');
  if (label !== board && !gates && !ownershipStores.has(label)) return;
  if (gates) mismatch();
  const protectedProjects = label === board ? ownership.rows.filter(row => row.role !== 'owner' || row.generation !== 1 || row.move_id)
    .map(row => row.project) : null;
  if (protectedProjects && !protectedProjects.length) return;
  if (!backup || !existsSync(path)) mismatch();
  if (snapshot(path, null, protectedProjects, ownership.spaceId) !== snapshot(backup, null, protectedProjects, ownership.spaceId)) mismatch();
}
