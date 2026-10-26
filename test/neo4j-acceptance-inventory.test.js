import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

// rec#31: Node files gated on a disposable Neo4j skip in `npm test`, so CI runs
// them only through `npm run test:neo4j`. A gated file missing from that script
// would silently go stale against the Provider's contract.
const GATES = /FULI_TEST_NEO4J_URI|realTaskContextEnabled/;

test('every Neo4j-gated Node test file runs in the serial test:neo4j script', () => {
  const testDirectory = new URL('./', import.meta.url);
  const self = new URL(import.meta.url).pathname.split('/').at(-1);
  const gated = readdirSync(testDirectory).filter(name => name.endsWith('.test.js') && name !== self
    && GATES.test(readFileSync(new URL(name, testDirectory), 'utf8'))).sort();
  const script = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['test:neo4j'];
  // One Provider principal per graph: concurrent files would rotate each other's bootstrap token.
  assert.match(script, /--test-concurrency=1/);
  const listed = [...script.matchAll(/test\/([\w.-]+\.test\.js)/g)].map(match => match[1]).sort();
  assert.ok(gated.length > 0);
  assert.deepEqual(listed, gated);
});
