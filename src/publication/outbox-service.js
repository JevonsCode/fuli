const MAX_LOOKAHEAD = '9999-12-31T23:59:59.999Z';
const SAFE_FAILURE = 'Publication delivery failed';

export class OutboxService {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
  }

  pending(at = this.now()) {
    return this.store.listPendingOutbox(toIso(at));
  }

  markSent(id) {
    return this.store.transaction(() => {
      this.#requirePending(id);
      return this.store.markOutboxSent(id, toIso(this.now()));
    }, { mode: 'immediate' });
  }

  markFailed(id, _error) {
    return this.store.transaction(() => {
      const row = this.#requirePending(id);
      const now = new Date(this.now());
      const delayMinutes = retryDelayMinutes(row.attempts + 1);
      const nextAttemptAt = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
      return this.store.markOutboxFailed(id, SAFE_FAILURE, nextAttemptAt);
    }, { mode: 'immediate' });
  }

  #requirePending(id) {
    const row = this.store.listPendingOutbox(MAX_LOOKAHEAD).find((item) => item.id === id);
    if (!row) throw new Error(`Pending Outbox row not found: ${id}`);
    return row;
  }
}

export function retryDelayMinutes(attempt) {
  return Math.min(30, 2 ** Math.max(0, attempt - 1));
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Outbox time must be valid');
  return date.toISOString();
}
