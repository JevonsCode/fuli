import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmployeeManagementStore } from '../src/employees/management-policy.js';

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
