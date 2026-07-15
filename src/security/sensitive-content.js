const DETECTORS = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ['api_key', /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|rk_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,})\b/],
  ['aws_credential_assignment', /\bAWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN)\s*[:=]\s*(?:"[^"]{16,}"|'[^']{16,}'|[A-Za-z0-9/+=]{16,})/i],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/],
  ['credential_assignment', /\b(?:password|passwd|passphrase|secret|api[-_ ]?key)\b\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,]+)/i],
  ['token_assignment', /\b(?:access[-_ ]?token|auth[-_ ]?token|token)\b\s*[:=]\s*(?:"[^"]{16,}"|'[^']{16,}'|[A-Za-z0-9._~+/=-]{16,})/i]
];

export function detectSensitiveContent(text) {
  if (typeof text !== 'string') return { restricted: false, reasons: [] };

  const reasons = DETECTORS
    .filter(([, pattern]) => pattern.test(text))
    .map(([reason]) => reason);
  return { restricted: reasons.length > 0, reasons };
}
