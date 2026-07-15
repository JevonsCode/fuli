import { cloneSnapshot, normalizeSnapshot } from '../snapshot-defaults.js';

export class SnapshotRepository {
  constructor(db, repositories) {
    this.db = db;
    this.repositories = repositories;
  }

  export() {
    const repositories = this.repositories;
    return cloneSnapshot({
      spaces: repositories.spaces.list(),
      subscriptions: repositories.subscriptions.list(),
      episodes: repositories.episodes.list(),
      facts: repositories.facts.list({ includeHistorical: true }),
      candidates: repositories.candidates.list(),
      outbox: repositories.outbox.listAll(),
      imports: repositories.imports.listAll()
    });
  }

  import(snapshot) {
    const current = this.export();
    const normalized = normalizeSnapshot(snapshot, {
      outbox: current.outbox,
      imports: current.imports
    });
    const replaceOutbox = Object.hasOwn(snapshot, 'outbox');
    const replaceImports = Object.hasOwn(snapshot, 'imports');
    const apply = () => this.replace(normalized, { replaceOutbox, replaceImports });

    if (this.db.inTransaction) apply();
    else this.db.transaction(apply)();
  }

  replace(snapshot, { replaceOutbox, replaceImports }) {
    const repositories = this.repositories;
    repositories.subscriptions.deleteAll();
    repositories.candidates.deleteAll();
    repositories.facts.deleteAll();
    repositories.episodes.deleteAll();
    if (replaceOutbox) repositories.outbox.deleteAll();
    if (replaceImports) repositories.imports.deleteAll();
    repositories.spaces.deleteAll();

    for (const space of snapshot.spaces) repositories.spaces.insertSnapshot(space);
    for (const subscription of snapshot.subscriptions) {
      repositories.subscriptions.insertSnapshot(subscription);
    }
    for (const episode of snapshot.episodes) repositories.episodes.insertSnapshot(episode);
    for (const fact of snapshot.facts) {
      repositories.facts.insertSnapshot(fact, { deferReplacement: true });
    }
    for (const fact of snapshot.facts) {
      if (fact.replacedByFactId) {
        repositories.facts.restoreReplacement(fact.id, fact.replacedByFactId);
      }
    }
    for (const candidate of snapshot.candidates) {
      repositories.candidates.insertSnapshot(candidate);
    }
    if (replaceOutbox) {
      for (const entry of snapshot.outbox) repositories.outbox.insertSnapshot(entry);
    }
    if (replaceImports) {
      for (const record of snapshot.imports) repositories.imports.insertSnapshot(record);
    }
  }
}
