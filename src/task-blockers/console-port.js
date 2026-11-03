import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';
import { projectAgentTaskRecord } from '../graphiti/project-agent-mapping.js';

// The person's 「标记为已解除」 of a blocked task whose session will never
// continue, or their confirmation of a block FULI saw as probably resolved,
// from the local console. It leaves on the human-review channel
// (human-review-channel.js); an Agent's access token alone is refused. An
// FLA's clear for the person (agent, from run_delegated_action) takes the same
// way and names the FLA. Only the console's loopback route uses this module;
// no MCP or Agent tool module imports it (test/task-blocker-clear-http.test.js).

export function taskBlockerConsole(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  return {
    async markUnblocked(taskId, { personalSpaceId, personalProjectId, note, confirmHint = false, agent = null }) {
      const path = `/v1/project-agent-tasks/${encodeURIComponent(taskId)}/blocker/clear`;
      const clearer = agent
        ? { cleared_by: 'agent', agent_id: agent.agentId ?? null, source_application: agent.client ?? null,
          source_session_id: agent.sessionId ?? null }
        : confirmHint ? { confirm_hint: true } : {};
      const { ok, status, payload } = await send(path,
        { personal_space_id: personalSpaceId, personal_project_id: personalProjectId, note, ...clearer }, { review: true });
      if (ok) return projectAgentTaskRecord(payload);
      throw providerRefusal(status, payload);
    }
  };
}
