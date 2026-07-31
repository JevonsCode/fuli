import { appendFileSync } from 'node:fs';

const AUDITED_TOOLS = new Set([
  'begin_task_context',
  'checkpoint_task_knowledge',
  'verify_task_checkpoint'
]);

export function auditLifecycleTool(
  toolName,
  {
    auditPath = process.env.FULI_ACCEPTANCE_LIFECYCLE_AUDIT_PATH,
    append = appendFileSync
  } = {}
) {
  if (!auditPath || !AUDITED_TOOLS.has(toolName)) return false;
  try {
    append(
      auditPath,
      `${JSON.stringify({ event: toolName })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    return true;
  } catch {
    return false;
  }
}
