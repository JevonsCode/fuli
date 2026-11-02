import { avatarLook } from '../avatars/look.js';
import { requiredString } from '../validation/values.js';
import { AgentAvatarStore } from './store.js';

// The agent-avatars port (rec#11 D-89). Identity is the agentId; the look is
// presentation the person picks: 'generated' draws the shared avatar renderer
// from another seed (a re-roll), 'image' shows a picture they uploaded,
// 'default' goes back to the built-in portrait or the agentId's own drawing.
// The choice itself is checked by avatars/look.js.
const AGENT_ID_MAX_CHARS = 128;
const VERSION_LENGTH = 16;

export function createAgentAvatars({ path = ':memory:', now = () => new Date() } = {}) {
  const store = new AgentAvatarStore(path);

  return {
    // Only the Agents whose look the person changed; every other one is drawn by default.
    list(personalSpaceId) {
      return { avatars: store.current(personalSpaceId).map(view) };
    },

    set({ personalSpaceId, agentId, look }) {
      const id = requiredString(agentId, 'agentId', AGENT_ID_MAX_CHARS);
      store.add({ personalSpaceId, agentId: id, ...avatarLook(look), at: now().toISOString() });
      return view(store.currentOf(personalSpaceId, id));
    },

    // The picture an Agent shows now, or null when it shows none.
    image({ personalSpaceId, agentId }) {
      const look = store.currentOf(personalSpaceId, requiredString(agentId, 'agentId', AGENT_ID_MAX_CHARS));
      if (look?.kind !== 'image') return null;
      return { ...store.image(look.imageSha256), version: look.imageSha256.slice(0, VERSION_LENGTH) };
    },

    close: () => store.close()
  };
}

function view(look) {
  return { agentId: look.agentId, kind: look.kind, ...(look.seed ? { seed: look.seed } : {}),
    ...(look.imageSha256 ? { imageVersion: look.imageSha256.slice(0, VERSION_LENGTH) } : {}), updatedAt: look.at };
}
