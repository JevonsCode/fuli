import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

export const OWNER_OPERATIONS_FILE = 'runner/owner-operations.sqlite';
export const OWNER_OPERATIONS_FORMAT = sqliteFormat({
  store: 'owner-operations',
  schema: `CREATE TABLE IF NOT EXISTS owner_operations(
    authority TEXT NOT NULL, operation TEXT NOT NULL, scope_key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT,
    PRIMARY KEY(authority,operation));`
});

// Claim before opening either business store. A crash after one store commits
// leaves a pending operation. Replaying that ID can only inspect its receipt.
const scopeKey = job => contentHash([job.spaceId, job.scope, job.owner, job.generation]);
export class OwnerOperationStore {
  constructor(path) { this.path = path; }

  get db() { return this.database ??= openFormattedDatabase(this.path, OWNER_OPERATIONS_FORMAT); }

  claim(authority, job) {
    const key = scopeKey(job);
    const digest = contentHash([key, job.action, job.input]);
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare('SELECT digest,result FROM owner_operations WHERE authority=? AND operation=?')
        .get(authority, job.requestId);
      if (row) {
        if (row.digest !== digest) return { result: { ok: false, code: 'operation_content_changed' } };
        return { result: row.result === null ? { ok: false, code: 'owner_result_unknown' } : JSON.parse(row.result) };
      }
      this.db.prepare('INSERT INTO owner_operations(authority,operation,scope_key,digest) VALUES(?,?,?,?)').run(authority, job.requestId, key, digest);
      return { digest };
    });
  }

  status(authority, job, operationId) {
    const row = this.db.prepare('SELECT result FROM owner_operations WHERE authority=? AND operation=? AND scope_key=?')
      .get(authority, operationId, scopeKey(job));
    if (!row) return { ok: false, code: 'owner_operation_not_found' };
    return row.result === null ? { ok: false, code: 'owner_result_unknown' } : JSON.parse(row.result);
  }

  finish(authority, operation, digest, result) {
    const saved = this.db.prepare('UPDATE owner_operations SET result=? WHERE authority=? AND operation=? AND digest=? AND result IS NULL')
      .run(JSON.stringify(result), authority, operation, digest);
    if (saved.changes !== 1) throw new Error('Project operation receipt changed');
    return result;
  }

  close() { this.database?.close(); this.database = null; }
}
