import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';

/** Tools that must not appear on default production MCP surfaces. */
export const TEST_ONLY_TOOL_NAMES = Object.freeze([
  'cleanup_test_project_agents'
]);

const TEST_ONLY_TOOL_NAME_SET = new Set(TEST_ONLY_TOOL_NAMES);

export function isTestOnlyToolName(name) {
  return TEST_ONLY_TOOL_NAME_SET.has(name);
}

/** Opt-in via FULI_ENABLE_TEST_TOOLS=1|true for local harnesses and e2e. */
export function testToolsEnabled(env = process.env) {
  const value = env?.FULI_ENABLE_TEST_TOOLS;
  return value === '1' || value === 'true';
}

export function assertTestToolsEnabled(env = process.env) {
  if (testToolsEnabled(env)) return;
  throw new ApplicationError(
    ApplicationErrorCode.VALIDATION,
    'cleanup_test_project_agents is disabled unless FULI_ENABLE_TEST_TOOLS=1'
  );
}
