import { randomUUID } from 'node:crypto';

import { nowIso } from '../../models.js';
import { mapSpace } from './mapper.js';

export class SpacesRepository {
  constructor(db) {
    this.insertStatement = db.prepare(`
      INSERT INTO spaces (id, name, kind, description, created_at)
      VALUES (@id, @name, @kind, @description, @createdAt)
    `);
    this.listStatement = db.prepare('SELECT * FROM spaces ORDER BY rowid');
    this.findByNameStatement = db.prepare('SELECT * FROM spaces WHERE name = ?');
    this.getStatement = db.prepare('SELECT * FROM spaces WHERE id = ?');
    this.deleteStatement = db.prepare('DELETE FROM spaces');
  }

  create(name, kind, description = null) {
    const existing = this.findByName(name);
    if (existing) return existing;

    const space = {
      id: randomUUID(),
      name,
      kind,
      description,
      createdAt: nowIso()
    };
    this.insertStatement.run(space);
    return this.get(space.id);
  }

  list() {
    return this.listStatement.all().map(mapSpace);
  }

  findByName(name) {
    return mapSpace(this.findByNameStatement.get(name));
  }

  get(id) {
    return mapSpace(this.getStatement.get(id));
  }

  insertSnapshot(space) {
    this.insertStatement.run(space);
  }

  deleteAll() {
    this.deleteStatement.run();
  }
}
