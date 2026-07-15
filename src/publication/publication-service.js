import { randomUUID } from 'node:crypto';

import { createEnvelope, verifyEnvelope } from './publication-envelope.js';
import { validatePublication } from './publication-policy.js';

export class PublicationService {
  constructor(store, { id = randomUUID } = {}) {
    this.store = store;
    this.id = id;
  }

  prepare(input) {
    validatePublication(this.store, input);
    return this.store.transaction(
      () => this.#validateBuildAndEnqueue(input),
      { mode: 'immediate' }
    );
  }

  prepareInCurrentTransaction(input) {
    return this.#validateBuildAndEnqueue(input);
  }

  verify(envelope) {
    return verifyEnvelope(envelope);
  }

  #validateBuildAndEnqueue(input) {
    const records = validatePublication(this.store, input);
    return this.#enqueue({
      spaceId: input.spaceId,
      envelope: createEnvelope({
        id: this.id(),
        spaceId: input.spaceId,
        ...records
      })
    });
  }

  #enqueue({ spaceId, envelope }) {
    const outbox = this.store.enqueueOutbox({
      kind: 'publication',
      aggregateId: `${spaceId}:${envelope.id}`,
      payload: { envelope }
    });
    return { envelope, outbox };
  }
}
