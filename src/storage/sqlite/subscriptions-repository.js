import { nowIso } from '../../models.js';
import { mapSubscription } from './mapper.js';

export class SubscriptionsRepository {
  constructor(db) {
    this.insertStatement = db.prepare(`
      INSERT INTO subscriptions (personal_space_id, space_id, mode, created_at)
      VALUES (@personalSpaceId, @spaceId, @mode, @createdAt)
    `);
    this.getStatement = db.prepare(`
      SELECT * FROM subscriptions
      WHERE personal_space_id = ? AND space_id = ?
    `);
    this.listStatement = db.prepare('SELECT * FROM subscriptions ORDER BY rowid');
    this.forPersonalSpaceStatement = db.prepare(`
      SELECT * FROM subscriptions WHERE personal_space_id = ? ORDER BY rowid
    `);
    this.deleteStatement = db.prepare('DELETE FROM subscriptions');
  }

  subscribe(personalSpaceId, spaceId, mode = 'latest') {
    const existing = this.get(personalSpaceId, spaceId);
    if (existing) return existing;

    const subscription = {
      personalSpaceId,
      spaceId,
      mode,
      createdAt: nowIso()
    };
    this.insertStatement.run(subscription);
    return this.get(personalSpaceId, spaceId);
  }

  list() {
    return this.listStatement.all().map(mapSubscription);
  }

  forPersonalSpace(personalSpaceId) {
    return this.forPersonalSpaceStatement.all(personalSpaceId).map(mapSubscription);
  }

  insertSnapshot(subscription) {
    this.insertStatement.run(subscription);
  }

  deleteAll() {
    this.deleteStatement.run();
  }

  get(personalSpaceId, spaceId) {
    return mapSubscription(this.getStatement.get(personalSpaceId, spaceId));
  }
}
