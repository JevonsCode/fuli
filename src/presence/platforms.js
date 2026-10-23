// The presence check each platform has (rec#7 D-28.1). Only Windows Hello
// exists; macOS and Linux have none yet and are refused rather than given a
// weaker substitute (a sudo cache or a typed password is not a fresh presence).
const PRESENCE_BY_PLATFORM = Object.freeze({ win32: 'hello' });

export function presenceKindFor(platform) {
  return Object.hasOwn(PRESENCE_BY_PLATFORM, platform) ? PRESENCE_BY_PLATFORM[platform] : null;
}

// What a presence check reports: verified, or refused with one of these reasons
// and a short detail (for example helper_digest_mismatch). Every refusal leaves
// the decision unverified.
const PRESENCE_REFUSALS = Object.freeze([
  'presence_canceled', 'presence_failed', 'presence_unavailable', 'presence_unsupported_platform'
]);

export const verifiedPresence = () => ({ verified: true });

export function presenceRefused(reason, detail) {
  if (!PRESENCE_REFUSALS.includes(reason)) throw new TypeError(`Unknown presence refusal ${reason}`);
  return { verified: false, reason, detail };
}
