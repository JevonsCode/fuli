import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EXTERNAL_WRITERS_NOTICE } from '../src/data-format/external-writers.js';
import { setupMigrationNotice } from '../src/data-format/format-notices.js';
import { personalGraphFormatState } from '../src/data-format/format-status.js';

// rec#17 D-09 part 2: one wording for the boundary of a confirmed graph
// migration, in the terminal, in `fuli setup` and in the console.

test('the console says the boundary in exactly the CLI wording', () => {
  const messages = readFileSync(new URL('../web/src/i18n/messages/data-format.ts', import.meta.url), 'utf8');
  assert.ok(messages.includes(`externalWriters: '${EXTERNAL_WRITERS_NOTICE.zh}'`), 'Chinese wording');
  assert.ok(messages.includes(`externalWriters: '${EXTERNAL_WRITERS_NOTICE.en}'`), 'English wording');
  assert.match(EXTERNAL_WRITERS_NOTICE.en, /Neo4j client, cypher-shell or other tools/);
});

test('setup names the stores that wait and the boundary, and says nothing otherwise', async () => {
  const waiting = () => [{ store: 'agent-apps', label: 'agent-apps/registry.sqlite', state: 'pending_confirmation',
    steps: ['agent-apps/7-identity-keys'] }, { store: 'judgment', label: 'judgment.sqlite', state: 'newer_format',
    steps: [] }];
  const notice = await setupMigrationNotice('/synthetic', { notices: waiting, graphState: async () => null });
  assert.match(notice, /Data format migrations wait for you: agent-apps\/registry\.sqlite\. Review them with fuli migrate preview/);
  assert.ok(notice.includes(EXTERNAL_WRITERS_NOTICE.zh) && notice.includes(EXTERNAL_WRITERS_NOTICE.en));
  assert.equal(await setupMigrationNotice('/synthetic', { notices: () => [], graphState: async () => null }), null);
});

test('setup names the personal graph when only its step waits, and leaves out a graph that does not answer', async () => {
  const graphOnly = await setupMigrationNotice('/synthetic', { notices: () => [],
    graphState: async () => ({ state: 'pending_confirmation', pending: ['graph/9-group-id-separators'] }) });
  assert.match(graphOnly, /^Data format migrations wait for you: graph \(personal\)\. Review them/);
  assert.ok(graphOnly.includes(EXTERNAL_WRITERS_NOTICE.en));

  const both = await setupMigrationNotice('/synthetic', { notices: () => [{ store: 'judgment', label: 'judgment.sqlite',
    state: 'pending_confirmation', steps: [] }], graphState: async () => ({ state: 'pending_confirmation', pending: [] }) });
  assert.match(both, /wait for you: judgment\.sqlite, graph \(personal\)\./);

  assert.equal(await setupMigrationNotice('/synthetic', { notices: () => [],
    graphState: async () => ({ state: 'current', pending: [] }) }), null);
  assert.equal(await setupMigrationNotice('/synthetic', { notices: () => [],
    graphState: async () => { throw new Error('not answering'); } }), null);
});

test('the personal graph state comes from its provider health, and is null when there is none', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-setup-graph-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(await personalGraphFormatState(root), null, 'not set up here');

  writeFileSync(join(root, 'graph-runtime.json'), JSON.stringify({ personal: { providerUrl: 'http://127.0.0.1:9/' } }));
  const asked = [];
  const healthy = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => ({ data_format: { state: 'pending_confirmation', pending: ['graph/9-x'] } }) };
  };
  assert.deepEqual(await personalGraphFormatState(root, { fetchImpl: healthy }),
    { state: 'pending_confirmation', pending: ['graph/9-x'] });
  assert.deepEqual(asked, ['http://127.0.0.1:9/health']);
  const refused = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await personalGraphFormatState(root, { fetchImpl: refused }), null);
});
