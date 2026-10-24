// The presence check each platform has (rec#7 D-28.1). Only Windows Hello
// exists. It is an optional extra on an Agent app approval (`--hello`, rec#11
// D-36.1), never required: every platform approves through the terminal
// confirmation flow, and a platform without a check simply has no `--hello`.
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
