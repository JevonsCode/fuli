import { onlineSourceUri } from './source-uri.js';

export async function recordKnowledgeFeedback(application, {
  personalSpaceId,
  taskId,
  sessionId = null,
  toolName = null,
  items
}) {
  return application.personal.recordKnowledgeFeedback({
    personal_space_id: personalSpaceId,
    task_id: taskId,
    session_id: sessionId,
    tool_name: toolName,
    items: items.map((item) => ({
      item_id: item.itemId,
      item_kind: item.itemKind,
      feedback_kind: item.feedbackKind,
      reason: item.reason,
      evidence_summary: item.evidenceSummary,
      reported_by_kind: item.reportedByKind,
      source_uri: onlineSourceUri(item.sourceUri)
    }))
  });
}
