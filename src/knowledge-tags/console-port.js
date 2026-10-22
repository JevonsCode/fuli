import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';

// The person's tag changes from the local console (rec#11 D-07 part 2): their
// own create, alias, attach and detach, and the governance only they apply
// (approve, merge, split, retire, relations, undo). The Provider records these
// as the person's, so they take the human-review token this port sends
// (human-review-channel.js); an Agent's access token alone is refused. That
// proves the local console, not a person's presence (same OS account, as in
// D-21/D-22). Only the console's loopback routes use this module; no MCP or
// Agent tool module imports it (test/knowledge-tags.test.js).

export function knowledgeTagsConsole(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  return {
    send: async (route, body) => {
      const { ok, status, payload } = await send(`/v1/knowledge-tags/${route}`, body, { review: true });
      if (ok) return payload;
      throw providerRefusal(status, payload);
    }
  };
}
