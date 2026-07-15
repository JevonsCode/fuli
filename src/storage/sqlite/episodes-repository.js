import { randomUUID } from 'node:crypto';

import { nowIso } from '../../models.js';
import { mapEpisode } from './mapper.js';

export class EpisodesRepository {
  constructor(db) {
    this.insertStatement = db.prepare(`
      INSERT INTO episodes (
        id, space_id, source_kind, body, source_uri, metadata_json, created_at
      ) VALUES (
        @id, @spaceId, @sourceKind, @body, @sourceUri, @metadataJson, @createdAt
      )
    `);
    this.getStatement = db.prepare('SELECT * FROM episodes WHERE id = ?');
    this.listStatement = db.prepare('SELECT * FROM episodes ORDER BY rowid');
    this.deleteStatement = db.prepare('DELETE FROM episodes');
  }

  add(spaceId, sourceKind, body, sourceUri = null, metadata = {}) {
    const episode = {
      id: randomUUID(),
      spaceId,
      sourceKind,
      body,
      sourceUri,
      metadataJson: JSON.stringify(metadata),
      createdAt: nowIso()
    };
    this.insertStatement.run(episode);
    return this.get(episode.id);
  }

  get(id) {
    return mapEpisode(this.getStatement.get(id));
  }

  list() {
    return this.listStatement.all().map(mapEpisode);
  }

  insertSnapshot(episode) {
    this.insertStatement.run({
      ...episode,
      metadataJson: JSON.stringify(episode.metadata)
    });
  }

  deleteAll() {
    this.deleteStatement.run();
  }
}
