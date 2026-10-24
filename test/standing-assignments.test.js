import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { inspectLocalStores } from '../src/data-format/local-stores.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// rec#29 F1: confirmed "this work goes to that Agent" records, matched
// without a model. Synthetic spaces, projects and Agents only.

const SPACE = 'space-synthetic';

function assignments(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-standing-'));
  const path = join(directory, 'standing-assignments.sqlite');
  let clock = Date.parse('2026-10-24T08:00:00.000Z');
  let ids = 0;
  const port = createStandingAssignments({ path, now: () => new Date(clock += 1000), newId: () => `sa-${++ids}` });
  t.after(() => { port.close(); rmSync(directory, { recursive: true, force: true }); });
  return { port, path, directory };
}

const timesheet = (overrides = {}) => ({ personalSpaceId: SPACE, projectId: 'project-timesheet',
  leadAgentId: 'agent-timesheet', terms: ['iDev'], responsibility: 'Fill iDev timesheet hours', source: 'user',
  sourceConversationId: 'conversation-1', ...overrides });

test('registering the same project and terms again returns the record without a revision', (t) => {
  const { port } = assignments(t);
  const first = port.register(timesheet({ terms: ['iDev', '工时'] }));
  assert.equal(first.status, 'created');
  assert.equal(first.assignment.revision, 1);
  const again = port.register(timesheet({ terms: [' IDEV ', '工时'], responsibility: 'Other wording' }));
  assert.equal(again.status, 'unchanged');
  assert.deepEqual(again.assignment, first.assignment);
  assert.equal(port.history(first.assignment.assignmentId).length, 1);
  assert.equal(port.list(SPACE).length, 1);
});

test('a new term extends the assignment and records the change as a new revision', (t) => {
  const { port } = assignments(t);
  const { assignment } = port.register(timesheet());
  const extended = port.register(timesheet({ terms: ['工时'], preferenceIds: ['pref-1'], sourceConversationId: 'conversation-2' }));
  assert.equal(extended.status, 'updated');
  assert.deepEqual(extended.assignment.terms, ['iDev', '工时']);
  assert.deepEqual(extended.assignment.preferenceIds, ['pref-1']);
  assert.equal(extended.assignment.revision, 2);
  assert.equal(extended.assignment.responsibility, assignment.responsibility);
  const history = port.history(assignment.assignmentId);
  assert.deepEqual(history.map(({ revision, change, sourceConversationId }) => [revision, change, sourceConversationId]),
    [[1, 'registered', 'conversation-1'], [2, 'extended', 'conversation-2']]);
  assert.deepEqual(history[0].record.terms, ['iDev']);
});

test('a term already naming another project is refused with that project named', (t) => {
  const { port } = assignments(t);
  port.register(timesheet());
  assert.throws(() => port.register(timesheet({ projectId: 'project-repo', leadAgentId: 'agent-repo', terms: ['idev', 'deploy'] })),
    (error) => error.code === 'standing_assignment_term_taken' && error.status === 409
      && error.message.includes('project-timesheet'));
  assert.deepEqual(port.match(SPACE, 'deploy now'), []);
  // The same project under another lead is a different assignment and is refused too.
  assert.throws(() => port.register(timesheet({ leadAgentId: 'agent-other' })), { code: 'standing_assignment_term_taken' });
});

test('terms are compared by case, width and spacing, and stored as written', (t) => {
  const { port } = assignments(t);
  const { assignment } = port.register(timesheet({ terms: ['  iDev   Timesheet ', 'ｉＤＥＶ　ＴＩＭＥＳＨＥＥＴ', 'Ｗｏｒｋ​Log'] }));
  // The first spelling is kept, composed and with its spacing tidied.
  assert.deepEqual(assignment.terms, ['iDev Timesheet', 'ＷｏｒｋLog']);
  assert.throws(() => port.register(timesheet({ projectId: 'other', terms: ['IDEV\ttimesheet'] })),
    { code: 'standing_assignment_term_taken' });
  assert.deepEqual(port.match(SPACE, 'please fill IDEV  TIMESHEET today').map(({ matchedTerms }) => matchedTerms),
    [['iDev Timesheet']]);
  assert.deepEqual(port.match(SPACE, 'ｗｏｒｋｌｏｇ updated').map(({ matchedTerms }) => matchedTerms), [['ＷｏｒｋLog']]);
  assert.throws(() => port.register(timesheet({ terms: ['​'] })), TypeError);
});

test('Latin terms match whole terms and CJK terms match inside running text', (t) => {
  const { port } = assignments(t);
  port.register(timesheet({ terms: ['iDev', '工时'] }));
  port.register(timesheet({ projectId: 'project-ops', leadAgentId: 'agent-ops', terms: ['部署'] }));
  const hits = (text) => port.match(SPACE, text).map(({ assignment, matchedTerms }) => [assignment.projectId, matchedTerms]);
  assert.deepEqual(hits('填今天的工时'), [['project-timesheet', ['工时']]]);
  assert.deepEqual(hits('fill today\'s iDev hours'), [['project-timesheet', ['iDev']]]);
  assert.deepEqual(hits('iDev工时，然后部署'), [['project-timesheet', ['iDev', '工时']], ['project-ops', ['部署']]]);
  assert.deepEqual(hits('(idev) and idev-hours'), [['project-timesheet', ['iDev']]]);
  for (const text of ['iDevelop the parser', 'myiDev', 'idev_hours', 'iDev2 build', 'nothing here']) {
    assert.deepEqual(hits(text), [], text);
  }
});

test('a retired assignment no longer matches and frees its terms, its history kept', (t) => {
  const { port } = assignments(t);
  const { assignment } = port.register(timesheet());
  assert.throws(() => port.retire(assignment.assignmentId, { source: 'user', expectedRevision: 0 }),
    { code: 'standing_assignment_changed' });
  const retired = port.retire(assignment.assignmentId, { source: 'user', expectedRevision: 1, sourceConversationId: 'conversation-3' });
  assert.equal(retired.revision, 2);
  assert.ok(retired.retiredAt);
  assert.deepEqual(port.match(SPACE, 'fill iDev hours'), []);
  assert.deepEqual(port.list(SPACE), []);
  assert.deepEqual(port.history(assignment.assignmentId).map(({ change }) => change), ['registered', 'retired']);
  const next = port.register(timesheet({ projectId: 'project-new', leadAgentId: 'agent-new' }));
  assert.equal(next.status, 'created');
  assert.deepEqual(port.match(SPACE, 'iDev').map(({ assignment: value }) => value.projectId), ['project-new']);
});

test('a host registration never changes what the person confirmed; the person confirms a host one', (t) => {
  const { port } = assignments(t);
  const { assignment } = port.register(timesheet());
  assert.equal(port.register(timesheet({ source: 'host' })).status, 'unchanged');
  assert.throws(() => port.register(timesheet({ source: 'host', terms: ['工时'] })),
    (error) => error.code === 'standing_assignment_user_confirmed' && error.status === 409);
  assert.throws(() => port.retire(assignment.assignmentId, { source: 'host', expectedRevision: 1 }),
    { code: 'standing_assignment_user_confirmed' });
  assert.equal(port.history(assignment.assignmentId).length, 1);

  const inferred = port.register(timesheet({ projectId: 'project-ops', leadAgentId: 'agent-ops', terms: ['部署'],
    source: 'host', sourceConversationId: 'conversation-host' })).assignment;
  const confirmed = port.register(timesheet({ projectId: 'project-ops', leadAgentId: 'agent-ops', terms: ['部署'],
    sourceConversationId: 'conversation-user' }));
  assert.equal(confirmed.status, 'updated');
  assert.equal(confirmed.assignment.source, 'user');
  assert.equal(confirmed.assignment.sourceConversationId, 'conversation-user');
  assert.deepEqual(port.history(inferred.assignmentId).map(({ change, source }) => [change, source]),
    [['registered', 'host'], ['confirmed', 'user']]);
});

test('revision rows are immutable', (t) => {
  const { port, path } = assignments(t);
  port.register(timesheet());
  port.close();
  const database = new DatabaseSync(path);
  try {
    assert.throws(() => database.exec("UPDATE standing_assignment_revisions SET change = 'edited'"), /immutable/);
    assert.throws(() => database.exec('DELETE FROM standing_assignment_revisions'), /immutable/);
    // REPLACE deletes the old row without the delete trigger; the insert trigger refuses it.
    assert.throws(() => database.exec('INSERT OR REPLACE INTO standing_assignment_revisions '
      + "SELECT assignment_id, revision, 'edited', source, source_conversation_id, record, recorded_at FROM standing_assignment_revisions"), /immutable/);
  } finally { database.close(); }
});

test('reads create no file, and the store is registered with the data directory', (t) => {
  const { port, path, directory } = assignments(t);
  assert.deepEqual(port.list(SPACE), []);
  assert.deepEqual(port.match(SPACE, 'iDev'), []);
  assert.equal(existsSync(path), false);
  assert.equal(inspectLocalStores(directory).find(({ label }) => label === 'standing-assignments.sqlite').state, 'absent');
  port.register(timesheet());
  const store = inspectLocalStores(directory).find(({ label }) => label === 'standing-assignments.sqlite');
  assert.deepEqual([store.store, store.state, store.version], ['standing-assignments', 'current', 1]);
});

test('a preview answers as register would, saving nothing and creating no file', (t) => {
  const { port, path } = assignments(t);
  assert.deepEqual(port.preview(timesheet({ projectId: null, leadAgentId: null, terms: [' iDev '] })), { status: 'created',
    assignment: null, terms: ['iDev'], responsibility: 'Fill iDev timesheet hours', preferenceIds: [] });
  assert.equal(existsSync(path), false);
  assert.throws(() => port.register(timesheet({ leadAgentId: null })), /leadAgentId is required/);
  const { assignment } = port.register(timesheet());
  assert.equal(port.preview(timesheet()).status, 'unchanged');
  assert.equal(port.preview(timesheet({ terms: ['工时'] })).assignment.assignmentId, assignment.assignmentId);
  assert.throws(() => port.preview(timesheet({ projectId: null, leadAgentId: null })), { code: 'standing_assignment_term_taken' });
  assert.equal(port.history(assignment.assignmentId).length, 1);
});

test('a space ID is read the same way by every call', (t) => {
  const { port } = assignments(t);
  port.register(timesheet());
  assert.equal(port.list(` ${SPACE} `).length, 1);
  assert.equal(port.match(` ${SPACE} `, 'fill iDev hours').length, 1);
});

test('a search of only invisible or space characters discovers nothing', (t) => {
  const { port } = assignments(t);
  port.register(timesheet());
  assert.deepEqual(port.discover(SPACE, 'iDev').map(({ matchedTerms }) => matchedTerms), [['iDev']]);
  for (const search of ['\u0085', '​', '\u0085\u001c']) assert.deepEqual(port.discover(SPACE, search), [], JSON.stringify(search));
});
