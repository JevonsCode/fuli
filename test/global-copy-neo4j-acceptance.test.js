import assert from 'node:assert/strict';
import test from 'node:test';

import { readGlobalCopyRecord } from '../src/runner/global-copy-state.js';
import { enabled, OWNER, replicaFixture } from '../test-support/replica-neo4j.js';

test('real Neo4j + Providers: the host\'s global reaches a follower, stays as the host has it, and is written back', {
  skip: !enabled, timeout: 300_000
}, async (t) => {
  const { dataDir, digestAnswer, asked, sync, cypher, restart, stop } = await replicaFixture(t);
  const first = await sync(false);
  assert.equal(first.outcome, 'synced', JSON.stringify(first));
  assert.deepEqual(asked.splice(0), ['digest', 'envelope']);
  assert.equal(readGlobalCopyRecord(dataDir).digest, digestAnswer.body.digest);
  // A system FLA of the host's, as copied here: one of its text fields.
  const [copied] = await cypher(`MATCH (n:FuliProjectAgent) WHERE n.fuli_replica_owner = $owner
    WITH n, [key IN keys(n) WHERE NOT key STARTS WITH 'fuli_replica' AND key <> 'id'
      AND valueType(n[key]) STARTS WITH 'STRING'][0] AS key WHERE key IS NOT NULL
    RETURN elementId(n) AS id, key, n[key] AS value ORDER BY id LIMIT 1`, { owner: OWNER });
  assert.ok(copied, 'the host\'s system FLAs are here as a copy, under the pinned owner');

  // Started again as a copy's: it writes no default of `global`, so the copy is still the host's.
  await restart(true);
  const restarted = await sync(true);
  assert.equal(restarted.outcome, 'synced', JSON.stringify(restarted));
  assert.equal(restarted.unchanged, true, `a restart as a copy's rewrote nothing: ${JSON.stringify(restarted.imported)}`);

  // Changed outside the sync: the recorded digest still matches, so only a verifying sync sees it.
  await cypher('MATCH (n) WHERE elementId(n) = $id SET n[$key] = $value', { id: copied.id, key: copied.key,
    value: 'Synthetic: changed outside the sync' });
  assert.equal((await sync(false)).unchanged, true, 'the digest alone cannot tell');
  const corrected = await sync(true);
  assert.equal(corrected.corrected, true, JSON.stringify(corrected));
  const [after] = await cypher('MATCH (n) WHERE elementId(n) = $id RETURN n[$key] AS value', { id: copied.id, key: copied.key });
  assert.equal(after.value, copied.value, 'written back as the host has it');
  await stop();
});
