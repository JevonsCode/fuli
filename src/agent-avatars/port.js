import { createHash } from 'node:crypto';

import { InvalidInputError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';
import { AgentAvatarStore } from './store.js';

// The agent-avatars port (rec#11 D-89). Identity is the agentId; the look is
// presentation the person picks: 'generated' draws the shared avatar renderer
// from another seed (a re-roll), 'image' shows a picture they uploaded,
// 'default' goes back to the built-in portrait or the agentId's own drawing.
// Pictures are raster only (PNG, JPEG, WebP or GIF, told by their bytes, never
// by a claimed type) and small: the console sends one already scaled down.
export const MAX_IMAGE_BYTES = 44 * 1024;
const LIMITS = Object.freeze({ agentId: 128, seed: 64 });
const KINDS = new Set(['generated', 'image', 'default']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const VERSION_LENGTH = 16;

export function createAgentAvatars({ path = ':memory:', now = () => new Date() } = {}) {
  const store = new AgentAvatarStore(path);

  return {
    // Only the Agents whose look the person changed; every other one is drawn by default.
    list(personalSpaceId) {
      return { avatars: store.current(personalSpaceId).map(view) };
    },

    set({ personalSpaceId, agentId, look }) {
      const id = requiredString(agentId, 'agentId', LIMITS.agentId);
      const kind = look?.kind;
      if (!KINDS.has(kind)) throw new InvalidInputError('look.kind is generated, image or default');
      const choice = kind === 'generated' ? { seed: requiredString(look.seed, 'look.seed', LIMITS.seed) }
        : kind === 'image' ? { image: picture(look.data) } : {};
      store.add({ personalSpaceId, agentId: id, kind, ...choice, at: now().toISOString() });
      return view(store.currentOf(personalSpaceId, id));
    },

    // The picture an Agent shows now, or null when it shows none.
    image({ personalSpaceId, agentId }) {
      const look = store.currentOf(personalSpaceId, requiredString(agentId, 'agentId', LIMITS.agentId));
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

function picture(data) {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) {
    throw new InvalidInputError('look.data is the picture as base64');
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new InvalidInputError(`A picture is at most ${MAX_IMAGE_BYTES / 1024} KiB; scale it down first`);
  }
  const mediaType = rasterType(bytes);
  if (!mediaType) throw new InvalidInputError('A picture is a PNG, JPEG, WebP or GIF image');
  return { bytes, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function rasterType(bytes) {
  const starts = (hex, at = 0) => bytes.subarray(at, at + hex.length / 2).toString('hex') === hex;
  if (starts('89504e470d0a1a0a')) return 'image/png';
  if (starts('ffd8ff')) return 'image/jpeg';
  if (starts('52494646') && starts('57454250', 8)) return 'image/webp';
  if (starts('474946383761') || starts('474946383961')) return 'image/gif';
  return null;
}
