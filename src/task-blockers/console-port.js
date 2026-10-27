import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';
import { projectAgentTaskRecord } from '../graphiti/project-agent-mapping.js';

// The person's 「标记为已解除」 of a blocked task whose session will never
// continue, from the local console. Only the person ends a block this way, so
// it leaves on the human-review channel (human-review-channel.js); an Agent's
// access token alone is refused. Only the console's loopback route uses this
// module; no MCP or Agent tool module imports it (test/task-blocker-clear-http.test.js).

export function taskBlockerConsole(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  return {
    async markUnblocked(taskId, { personalSpaceId, personalProjectId, note }) {
      const path = `/v1/project-agent-tasks/${encodeURIComponent(taskId)}/blocker/clear`;
      const { ok, status, payload } = await send(path,
        { personal_space_id: personalSpaceId, personal_project_id: personalProjectId, note }, { review: true });
      if (ok) return projectAgentTaskRecord(payload);
      throw providerRefusal(status, payload);
    }
  };
}
