export function classifyClaudeCaseStatus({
  passed,
  errors = []
}) {
  if (errors.some(isClaudeInfrastructureError)) return 'ERROR';
  return passed ? 'PASS' : 'FAIL';
}

export function isClaudeInfrastructureError(error) {
  const message = String(error ?? '');
  return /\bAPI Error:\s*5\d{2}\b/i.test(message)
    || /\binference gateway\b/i.test(message);
}

export function summarizeClaudeExecutionError(error) {
  const message = String(error ?? '');
  const status = message.match(/\bAPI Error:\s*(\d{3})\b/i)?.[1];
  if (status && /\binference gateway\b/i.test(message)) {
    return `Claude API returned HTTP ${status} through the configured inference gateway.`;
  }
  if (status) return `Claude API returned HTTP ${status}.`;
  if (/\btimed out\b/i.test(message)) return 'Claude execution timed out.';
  if (/\b(?:ENOENT|command not found)\b/i.test(message)) {
    return 'Claude executable is unavailable.';
  }
  return 'Claude execution failed before a usable result was produced.';
}

export function composeResourcesRemoved({
  containers,
  networks,
  volumes
}) {
  return [containers, networks, volumes]
    .every((value) => String(value ?? '').trim() === '');
}
