import { InvalidInputError } from '../app/application-error.js';
import { sha256Bytes } from '../security/digest.js';
import { requiredString } from '../validation/values.js';

// A portrait the person picks, for an Agent (rec#11 D-89) or for their own
// 「我」 (person-profile): 'generated' draws the shared avatar renderer from a
// seed, 'image' is a picture they uploaded, 'default' goes back to the
// built-in face. Pictures are raster only (PNG, JPEG, WebP or GIF, told by
// their bytes, never by a claimed type) and small: the console sends one
// already cropped to a square and scaled down.
export const MAX_AVATAR_PICTURE_BYTES = 44 * 1024;
const SEED_MAX_CHARS = 64;
const KINDS = new Set(['generated', 'image', 'default']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// The checked choice: { kind, seed } | { kind, image: { bytes, mediaType, sha256 } } | { kind }.
export function avatarLook(look) {
  const kind = look?.kind;
  if (!KINDS.has(kind)) throw new InvalidInputError('look.kind is generated, image or default');
  if (kind === 'generated') return { kind, seed: requiredString(look.seed, 'look.seed', SEED_MAX_CHARS) };
  if (kind === 'image') return { kind, image: avatarPicture(look.data) };
  return { kind };
}

function avatarPicture(data) {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) {
    throw new InvalidInputError('look.data is the picture as base64');
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_PICTURE_BYTES) {
    throw new InvalidInputError(`A picture is at most ${MAX_AVATAR_PICTURE_BYTES / 1024} KiB; scale it down first`);
  }
  const mediaType = rasterType(bytes);
  if (!mediaType) throw new InvalidInputError('A picture is a PNG, JPEG, WebP or GIF image');
  return { bytes, mediaType, sha256: sha256Bytes(bytes) };
}

function rasterType(bytes) {
  const starts = (hex, at = 0) => bytes.subarray(at, at + hex.length / 2).toString('hex') === hex;
  if (starts('89504e470d0a1a0a')) return 'image/png';
  if (starts('ffd8ff')) return 'image/jpeg';
  if (starts('52494646') && starts('57454250', 8)) return 'image/webp';
  if (starts('474946383761') || starts('474946383961')) return 'image/gif';
  return null;
}
