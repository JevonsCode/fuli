import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { EXTERNAL_WRITERS_NOTICE } from '../src/data-format/external-writers.js';
import { setupMigrationNotice } from '../src/data-format/format-notices.js';

// rec#17 D-09 part 2: one wording for the boundary of a confirmed graph
// migration, in the terminal, in `fuli setup` and in the console.

test('the console says the boundary in exactly the CLI wording', () => {
  const messages = readFileSync(new URL('../web/src/i18n/messages/data-format.ts', import.meta.url), 'utf8');
  assert.ok(messages.includes(`externalWriters: '${EXTERNAL_WRITERS_NOTICE.zh}'`), 'Chinese wording');
  assert.ok(messages.includes(`externalWriters: '${EXTERNAL_WRITERS_NOTICE.en}'`), 'English wording');
  assert.match(EXTERNAL_WRITERS_NOTICE.en, /Neo4j client, cypher-shell or other tools/);
});

test('setup names the stores that wait and the boundary, and says nothing otherwise', async () => {
  const waiting = () => [{ store: 'task-schedules', label: 'task-schedules.sqlite', state: 'pending_confirmation',
    steps: ['task-schedules/3-run-recovery'] }, { store: 'judgment', label: 'judgment.sqlite', state: 'newer_format',
    steps: [] }];
  const notice = setupMigrationNotice('/synthetic', { notices: waiting });
  assert.match(notice, /Data format migrations wait for you: task-schedules\.sqlite\. Review them with fuli migrate preview/);
  assert.ok(notice.includes(EXTERNAL_WRITERS_NOTICE.zh) && notice.includes(EXTERNAL_WRITERS_NOTICE.en));
  assert.equal(setupMigrationNotice('/synthetic', { notices: () => [] }), null);
});
