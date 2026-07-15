import { mapImport } from './mapper.js';

export class ImportsRepository {
  constructor(db) {
    this.insertStatement = db.prepare(`
      INSERT INTO imports (content_hash, source_path, imported_at)
      VALUES (@contentHash, @sourcePath, @importedAt)
    `);
    this.hasStatement = db.prepare(`
      SELECT 1 FROM imports WHERE content_hash = ?
    `);
    this.listStatement = db.prepare('SELECT * FROM imports ORDER BY rowid');
    this.deleteStatement = db.prepare('DELETE FROM imports');
  }

  has(contentHash) {
    return this.hasStatement.get(contentHash) !== undefined;
  }

  record(record) {
    if (this.has(record.contentHash)) {
      throw new Error(`Duplicate import content hash: ${record.contentHash}`);
    }
    this.insertStatement.run(record);
    return { ...record };
  }

  listAll() {
    return this.listStatement.all().map(mapImport);
  }

  insertSnapshot(record) {
    this.insertStatement.run(record);
  }

  deleteAll() {
    this.deleteStatement.run();
  }
}
