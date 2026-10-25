import { captureDecision } from './capture-decision.js';

// View records rank knowledge by what a session looked at: a behavior trace
// that stops with automatic recording. Reading itself needs none (rec#11 D-01).
export async function recordAgentViews(application, items, toolName, scope) {
  if (!items.length || !(await captureDecision(application, scope)).allowed) return;
  const unique = new Map(items.map((item) => [
    `${item.item_kind}:${item.item_id}`,
    item
  ]));
  const values = [...unique.values()];
  for (let index = 0; index < values.length; index += 200) {
    await application.personal.recordAgentViews({
      personal_space_id: application.config.personal.spaceId,
      tool_name: toolName,
      items: values.slice(index, index + 200)
    });
  }
}
