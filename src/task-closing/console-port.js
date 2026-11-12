import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';
import { projectAgentTaskRecord } from '../graphiti/project-agent-mapping.js';

// The person completes or cancels a task themself (rec#123), from the local
// console or through an FLA relaying their words (run_delegated_action, an
// agent_relayed route). It is the person's acceptance, so the Provider asks for
// no participating Agent and no verified artifact revision; it leaves on the
// human-review channel, so an Agent's access token alone is refused. Only the
// console's loopback route uses this module; no MCP or Agent tool module
// imports it (test/task-close-http.test.js).
export function taskCloseConsole(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  return {
    async closeAsPerson(taskId, { personalSpaceId, personalProjectId, status, summary, relayer = null }) {
      const path = `/v1/project-agent-tasks/${encodeURIComponent(taskId)}/close`;
      const relayed = relayer
        ? { relayed_by: relayer.agentId ?? null, source_application: relayer.client ?? null,
          source_session_id: relayer.sessionId ?? null }
        : {};
      const { ok, status: code, payload } = await send(path,
        { personal_space_id: personalSpaceId, personal_project_id: personalProjectId, status, summary, ...relayed },
        { review: true });
      if (ok) return projectAgentTaskRecord(payload);
      throw providerRefusal(code, payload);
    }
  };
}
