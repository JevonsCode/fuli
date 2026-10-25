import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The console session of one console launch (rec#11 D-61). The launch keeps a
// random secret in memory only; it is never written, logged or put in a URL.
// `fuli open` asks for a one-time code (http.js), the browser redeems it once
// within CODE_TTL_MS, and the answer is a cookie derived from the secret. Only
// a request carrying that cookie gets the console's human-review reads and
// changes (session-ports.js). A new launch has a new secret, so a cookie from
// an earlier launch no longer counts.

const SECRET_BYTES = 32;
const CODE_BYTES = 32;
export const CODE_TTL_MS = 60_000;
// More codes than this waiting at once drops the oldest; a person opens one at a time.
const MAX_PENDING_CODES = 8;
const COOKIE_LABEL = 'fuli-console-session';

const digest = (text) => createHash('sha256').update(text).digest();

export function createConsoleSession({ random = randomBytes, now = Date.now, codeTtlMs = CODE_TTL_MS } = {}) {
  const secret = random(SECRET_BYTES);
  const cookieValue = createHmac('sha256', secret).update(COOKIE_LABEL).digest('base64url');
  // Each entry keeps the code's digest, so every comparison is between equal-length values.
  let pending = [];
  const dropExpired = () => { pending = pending.filter(entry => entry.expiresAt > now()); };
  return {
    // next: the console path to land on, already validated (next-path.js).
    issueCode(next) {
      dropExpired();
      const code = random(CODE_BYTES).toString('base64url');
      pending = [...pending, { digest: digest(code), next, expiresAt: now() + codeTtlMs }].slice(-MAX_PENDING_CODES);
      return code;
    },
    // The code's landing path, once; null for an unknown, used or expired code.
    // Every waiting code is compared in constant time; none is skipped early.
    redeem(code) {
      dropExpired();
      if (typeof code !== 'string' || !code) return null;
      const offered = digest(code);
      let match = null;
      for (const entry of pending) {
        if (timingSafeEqual(entry.digest, offered)) match = entry;
      }
      if (!match) return null;
      pending = pending.filter(entry => entry !== match);
      return { next: match.next };
    },
    // Burns a code without signing in (a redemption that came from another site).
    discard(code) {
      if (typeof code !== 'string' || !code) return;
      const offered = digest(code);
      pending = pending.filter(entry => !timingSafeEqual(entry.digest, offered));
    },
    cookieValue: () => cookieValue,
    isValid(value) {
      if (typeof value !== 'string') return false;
      const offered = Buffer.from(value);
      const expected = Buffer.from(cookieValue);
      return offered.length === expected.length && timingSafeEqual(offered, expected);
    }
  };
}
