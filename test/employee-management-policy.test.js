import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmployeeManagementStore, managementFor } from '../src/employees/management-policy.js';

test('employee policies persist by exact space/template and reject a stale writer in another host', () => {
  const directory = mkdtempSync(join(tmpdir(), 'employee-policy-test-'));
  const file = join(directory, 'policy.sqlite');
  const first = new EmployeeManagementStore(file);
  const second = new EmployeeManagementStore(file);
  try {
    const policy = { mode: 'all', excludedProjectIds: ['private-project'], titleMode: 'auto' };
    first.write('space-a', 'jefa', policy, 0);
    assert.equal(second.read('space-a', 'jefa').revision, 1);
    assert.deepEqual(second.read('space-a', 'jefa').excludedProjectIds, ['private-project']);
    assert.equal(second.read('space-b', 'jefa'), null);
    assert.equal(second.read('space-a', 'concierge'), null);
    assert.throws(() => second.write('space-a', 'jefa', { ...policy, excludedProjectIds: [] }, 0), { code: 'assignment_scope_conflict' });
    assert.deepEqual(first.read('space-a', 'jefa').excludedProjectIds, ['private-project']);
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('fixed roles nobody has assigned manage all projects; configured employees keep their selection', () => {
  const jefa = { id: 'jefa', defaultProjectScope: 'all', taskEntry: {} };
  const concierge = { id: 'concierge', defaultProjectScope: 'all' };
  const systemIdentity = { agentId: 'employee.jefa', assignments: [] };
  assert.equal(managementFor(jefa, systemIdentity, null).mode, 'all');
  const assigned = { agentId: 'employee.jefa', assignments: [{ personalProjectId: 'p-1', status: 'active' }] };
  assert.deepEqual(managementFor(jefa, assigned, null), {
    revision: 0, mode: 'selected', projectIds: ['p-1'], excludedProjectIds: [], titleMode: 'auto', titleStyle: 'emoji' });
  assert.equal(managementFor(concierge, { agentId: 'employee.concierge', assignments: [] }, null).mode, 'selected');
  assert.equal(managementFor(concierge, null, null).mode, 'all');
});
