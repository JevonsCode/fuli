import { contentHash } from '../../../../packages/roundtable/src/canonical-json.js';
import { immediateTransaction } from '../../../../packages/roundtable/src/storage/database-format.js';
import { EmployeeError } from '../../manifest.js';

const FORMAT = 5;
const MAX_BYTES = 64 * 1024 * 1024;
const TABLES = ['jefa_projects', 'jefa_work_items', 'jefa_work_item_revisions', 'jefa_requests',
  'jefa_session_titles', 'jefa_project_boards', 'jefa_project_board_revisions'];
const IMMUTABLE = new Set(['jefa_work_item_revisions', 'jefa_project_board_revisions', 'jefa_requests']);
const refuse = code => { throw new EmployeeError('The project board could not be transferred safely.', 409, code); };

// Both peers must run this board format. Columns and keys come from local schema
// metadata. No table, column, order or SQL expression comes from the peer.
function layout(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== FORMAT) refuse('board_format_changed');
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'jefa_*'").all();
  if (names.length !== TABLES.length || !names.every(row => TABLES.includes(row.name))) refuse('board_format_changed');
  return TABLES.map(name => {
    const fields = db.prepare('SELECT name,pk FROM pragma_table_info(?) ORDER BY cid').all(name);
    if (!fields.every(row => /^[a-z_]+$/.test(row.name))) refuse('board_format_changed');
    const columns = fields.map(row => row.name);
    const keys = fields.filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name);
    return { name, columns, keys };
  });
}

function contents(db, { spaceId, projectId }) {
  let bytes = 0;
  const tables = layout(db).map(({ name, columns, keys }) => {
    const rows = [];
    const select = db.prepare('SELECT * FROM ' + name + ' WHERE space_id=? AND project_id=? ORDER BY ' + keys.join(','));
    for (const item of select.iterate(spaceId, projectId)) {
      const values = columns.map(column => item[column]);
      bytes += Buffer.byteLength(JSON.stringify(values)) + 1;
      if (bytes > MAX_BYTES) refuse('board_too_large');
      rows.push(values);
    }
    return { name, columns, count: rows.length, rows };
  });
  const body = { version: 1, boardFormat: FORMAT, spaceId, projectId, tables };
  const snapshot = { ...body, digest: contentHash(body) };
  checkSize(snapshot);
  return snapshot;
}

// A prior copy may already hold the same slug. A different project must
// never start serving the incoming project's share link.
export function checkProjectBoardShares(db, scope, snapshot) {
  const table = snapshot?.tables?.find(table => table.name === 'jefa_projects');
  const index = table?.columns.indexOf('share_slug');
  for (const row of table?.rows ?? []) {
    const slug = row[index];
    if (slug && db.prepare('SELECT 1 FROM jefa_projects WHERE share_slug=? AND NOT(space_id=? AND project_id=?)')
      .get(slug, scope.spaceId, scope.projectId)) refuse('board_share_conflict');
  }
}

function checkSize(snapshot) {
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) refuse('board_too_large');
}

export function exportProjectBoard(db, scope) {
  db.exec('BEGIN');
  try { return contents(db, scope); } finally { db.exec('ROLLBACK'); }
}

// The move participant supplies the last sealed digest from its local control
// record for a prior read-only copy. Every row of that baseline must survive.
// Call only after sealing the project's write gate.
export function installProjectBoard(db, scope, incoming, { baselineDigest, installedDigest } = {}) {
  if (!incoming || incoming.spaceId !== scope.spaceId || incoming.projectId !== scope.projectId ||
    incoming.version !== 1 || incoming.boardFormat !== FORMAT || incoming.tables?.length !== TABLES.length) refuse('board_scope_changed');
  checkSize(incoming);
  const { digest, ...body } = incoming;
  if (contentHash(body) !== digest) refuse('board_digest_changed');
  return immediateTransaction(db, () => {
    const current = contents(db, scope);
    if (installedDigest === digest && current.digest === digest) return digest;
    if (current.tables.some(table => table.count) && current.digest !== baselineDigest) refuse('board_target_not_empty');
    const schema = layout(db);
    for (let i = 0; i < schema.length; i++) {
      const { name, columns, keys } = schema[i];
      const payload = incoming.tables[i];
      if (payload?.name !== name || JSON.stringify(payload.columns) !== JSON.stringify(columns) ||
        !Array.isArray(payload.rows) || payload.count !== payload.rows.length) refuse('board_format_changed');
      const key = row => JSON.stringify(keys.map(field => row[columns.indexOf(field)]));
      const previous = new Map(current.tables[i].rows.map(row => [key(row), row]));
      const incomingKeys = new Set();
      const mutable = columns.filter(column => !keys.includes(column));
      let insertSql = 'INSERT INTO ' + name + '(' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')';
      if (!IMMUTABLE.has(name)) insertSql += ' ON CONFLICT(' + keys.join(',') + ') DO UPDATE SET ' +
        mutable.map(column => column + '=excluded.' + column).join(',');
      const insert = db.prepare(insertSql);
      for (const row of payload.rows) {
        if (!Array.isArray(row) || row.length !== columns.length || row[columns.indexOf('space_id')] !== scope.spaceId ||
          row[columns.indexOf('project_id')] !== scope.projectId) refuse('board_scope_changed');
        const id = key(row);
        if (incomingKeys.has(id)) refuse('board_duplicate_key');
        incomingKeys.add(id);
        const before = previous.get(id);
        if (before && JSON.stringify(row) === JSON.stringify(before)) continue;
        if (before && IMMUTABLE.has(name)) refuse('board_history_conflict');
        insert.run(...row);
      }
      if ([...previous.keys()].some(id => !incomingKeys.has(id))) refuse('board_history_missing');
    }
    checkProjectBoardShares(db, scope, incoming);
    if (contents(db, scope).digest !== digest) refuse('board_digest_changed');
    return digest;
  });
}
