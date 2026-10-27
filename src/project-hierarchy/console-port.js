import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';

// The person's move of a personal project in their hierarchy, from the local
// console's projects view. The parent decides which knowledge a project
// inherits, so like the other scope changes it leaves on the human-review
// channel (human-review-channel.js); an Agent's access token alone is refused.
// Only the console's loopback route uses this module; no MCP or Agent tool
// module imports it (test/project-hierarchy-http.test.js).

export function projectHierarchyConsole(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  return {
    async moveProject(spaceId, projectId, body) {
      const path = `/v1/personal-spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/parent`;
      const { ok, status, payload } = await send(path, body, { review: true });
      if (ok) return payload;
      throw providerRefusal(status, payload);
    }
  };
}
