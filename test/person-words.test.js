import assert from 'node:assert/strict';
import test from 'node:test';
import { onlyHostText, personWords } from '../src/conversations/person-words.js';

// Synthetic host notes only: no real transcript is read here.
const REPORT = 'Its CI failure, a test stub missing copyFile, is fixed and the fix is on main.\n'
  + '[example/tidewater#42](https://example.test/pr/42) is merged, with 9 checks passing and 2 skipped.';

test('host envelopes, pasted blocks and quoted lines are not the person\'s words', () => {
  for (const tag of ['system-reminder', 'side-sessions-event', 'task-notification', 'cross-session-message',
    'ci-monitor-event', 'environment_context', 'EXTREMELY_IMPORTANT']) {
    assert.equal(personWords(`<${tag}>\n${REPORT}\n</${tag}>`), '', tag);
    assert.equal(onlyHostText(`<${tag}>${REPORT}</${tag}>`), true, tag);
  }
  assert.equal(personWords(`<pasted_content id="p1">\n${REPORT}\n</pasted_content>`), '');
  assert.equal(personWords(`> ${REPORT.replace('\n', '\n> ')}`), '');
  assert.equal(personWords(`<system-reminder>Linked sessions: <side-sessions-event>${REPORT}</side-sessions-event> done</system-reminder>`), '');
});

test('the person\'s own text around host notes stays, and ordinary markup is not a host note', () => {
  assert.equal(personWords(`<system-reminder>${REPORT}</system-reminder>\nThe staging port is 4611.`), 'The staging port is 4611.');
  assert.equal(personWords('Wrap the label in <b>bold</b> text.'), 'Wrap the label in <b>bold</b> text.');
  assert.equal(personWords('Compare a > b in the sort.'), 'Compare a > b in the sort.');
  assert.equal(onlyHostText('Fix the sort.'), false);
  assert.equal(onlyHostText(''), false);
  assert.equal(personWords(null), '');
});
