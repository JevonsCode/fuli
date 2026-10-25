import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The console session of one console launch (rec#11 D-61). The launch keeps a
// random secret in memory only; it is never written, logged or put in a URL.
// `fuli open` asks for a one-time code (http.js), the console page redeems it
// once within CODE_TTL_MS, and gets two credentials derived from the secret:
// an HttpOnly cookie and a token the page keeps in its origin's storage and
// sends as a header. A cookie reaches every port of the host, so the cookie
// alone is not enough; the token stays with this console's origin. Only a
// request carrying both gets the console's protected reads and changes
// (session-ports.js). A new launch has a new secret, so neither credential
// of an earlier launch counts.

const SECRET_BYTES = 32;
const CODE_BYTES = 32;
export const CODE_TTL_MS = 60_000;
// More codes than this waiting at once drops the oldest; a person opens one at a time.
const MAX_PENDING_CODES = 8;

const digest = (text) => createHash('sha256').update(text).digest();

function sameValue(offered, expected) {
  if (typeof offered !== 'string') return false;
  const left = Buffer.from(offered);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createConsoleSession({ random = randomBytes, now = Date.now, codeTtlMs = CODE_TTL_MS } = {}) {
  const secret = random(SECRET_BYTES);
  const derive = (label) => createHmac('sha256', secret).update(label).digest('base64url');
  const credentials = Object.freeze({ cookie: derive('fuli-console-session-cookie'), token: derive('fuli-console-session-token') });
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
    // Burns a code without signing in (a code that reached a URL).
    discard(code) {
      if (typeof code !== 'string' || !code) return;
      const offered = digest(code);
      pending = pending.filter(entry => !timingSafeEqual(entry.digest, offered));
    },
    credentials: () => credentials,
    // Both credentials of this launch, each compared in constant time.
    isSignedIn({ cookie, token }) {
      const cookieMatches = sameValue(cookie, credentials.cookie);
      const tokenMatches = sameValue(token, credentials.token);
      return cookieMatches && tokenMatches;
    }
  };
}
