import assert from 'node:assert/strict';
import test from 'node:test';

import { SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

const PREVIEW_BYTES = 1024;
const PADDING = 'x'.repeat(PREVIEW_BYTES + 256);
const POLICY = 'password policy: rotate regularly';
const CREDENTIAL = 'password=correct-horse-battery-staple';

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SQLite', () => new SqliteStore(':memory:')]
]) {
  test(`${name} evidence privacy uses exact detector semantics for source and corrections`, () => {
    const store = createStore();
    try {
      const personal = store.createSpace(`${name}-me`, SpaceKind.PERSONAL);
      const policySource = store.addEpisode(personal.id, 'conversation', POLICY);
      const secretSource = store.addEpisode(
        personal.id,
        'conversation',
        `${PADDING} ${CREDENTIAL}`
      );
      const policyFactId = 'policy-fact';
      const policyCorrection = store.addEpisode(
        personal.id,
        'correction',
        POLICY,
        null,
        { kind: 'lens_correction', factId: policyFactId, action: 'replace' }
      );
      store.addEpisode(
        personal.id,
        'correction',
        `${PADDING} ${CREDENTIAL}`,
        null,
        { kind: 'lens_correction', factId: policyFactId, action: 'reject' }
      );

      const policyPreview = store.episodeEvidencePreview(personal.id, policySource.id, {
        maxBodyBytes: PREVIEW_BYTES,
        includeRestricted: false
      });
      const secretPreview = store.episodeEvidencePreview(personal.id, secretSource.id, {
        maxBodyBytes: PREVIEW_BYTES,
        includeRestricted: false
      });
      const group = store.correctionEpisodeEvidencePreviews(
        personal.id,
        [policyFactId],
        { maxBodyBytes: PREVIEW_BYTES, includeRestricted: false }
      )[0];

      assert.equal(policyPreview.body, POLICY, name);
      assert.equal(secretPreview, null, name);
      assert.deepEqual(group.episodes.map(({ id }) => id), [policyCorrection.id], name);
      assert.equal(group.truncated, false, name);
    } finally {
      store.close();
    }
  });
}
