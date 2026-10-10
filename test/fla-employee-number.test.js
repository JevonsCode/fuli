import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAgentRecord } from '../src/graphiti/project-agent-mapping.js';

test('employee numbers are preserved as strings without replacing identity keys', () => {
  for (const employee_number of ['000001', '999999', '1000000']) {
    const result = projectAgentRecord({ agent_id: 'stable-id', employee_number, profile: {} });
    assert.equal(result.agentId, 'stable-id');
    assert.equal(result.employeeNumber, employee_number);
  }
});
