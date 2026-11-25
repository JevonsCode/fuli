import { detectSensitiveContent, redactSensitiveContent } from '../security/sensitive-content.js';

// Team templates travel between projects. Their free text is written for the
// source team, so it may name a host path, an account, a credential, a source
// identifier or a private link without meaning to. Only the description
// travels: each such part is replaced by a marker and counted, never repeated
// in an error or a result. Structured identity and access are not part of a
// template at all (see export.js); this module handles the free text.

// Absolute paths and file URLs belong to the computer that wrote them. A
// relative path (src/foo.js) is portable and stays.
const HOST_PATHS = [
  ['host_path', /\b[A-Za-z]:\\[^\r\n"'<>|]*/g],
  ['host_path', /\b[A-Za-z]:\/[^\r\n"'<>|]*/g],
  ['host_path', /\\\\[^\s"'<>|]+/g],
  ['host_path', /(^|[\s"'`(])(?:~\/|\/(?:home|Users|root|mnt|private|tmp)\/)[^\s"'<>|)]*/gm, 1],
  ['host_path', /\bfile:\/\/[^\s"'<>|]+/gi]
];
// A public link may be part of the work; a link to this computer, this
// network, or one carrying credentials is not.
const PRIVATE_LINKS = [
  ['private_link', /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3})(?::\d+)?[^\s"'<>)]*/gi],
  ['private_link', /\bhttps?:\/\/(?:[^\s/@]+@)[^\s"'<>)]*/gi],
  ['private_link', /\bhttps?:\/\/[^\s"'<>/]*\.local(?::\d+)?[^\s"'<>)]*/gi]
];
const PERSON_IDENTIFIERS = [
  ['person_identifier', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['source_identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi]
];

// Text that is safe to put in a template, and why parts of it were replaced.
// identifiers are exact strings the caller knows belong to the source (an
// Agent ID, the source project, a source-only name); matching is literal.
export function portableText(value, { identifiers = [] } = {}) {
  if (typeof value !== 'string' || !value) return { text: value, reasons: [] };
  const reasons = [];
  const mark = reason => {
    reasons.push(reason);
    return `[redacted:${reason}]`;
  };
  let text = redactSensitiveContent(value);
  if (text !== value) {
    for (const reason of detectSensitiveContent(value).reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  for (const [reason, pattern, prefixGroup] of [...HOST_PATHS, ...PRIVATE_LINKS, ...PERSON_IDENTIFIERS]) {
    if (prefixGroup) {
      text = text.replace(pattern, (...args) => `${args[prefixGroup]}${mark(reason)}`);
      continue;
    }
    text = text.replace(pattern, () => mark(reason));
  }
  const known = [...new Set(identifiers.filter(identifier => typeof identifier === 'string' && identifier.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const identifier of known) {
    const pattern = new RegExp(escapeRegExp(identifier), 'gi');
    text = text.replace(pattern, () => mark('source_identifier'));
  }
  return { text, reasons };
}

export function emptyRedactions() {
  return { fields: 0, dropped: 0, reasons: {} };
}

export function addRedaction(total, reasons, { dropped = false } = {}) {
  if (!reasons.length) return total;
  total.fields += 1;
  if (dropped) total.dropped += 1;
  for (const reason of reasons) total.reasons[reason] = (total.reasons[reason] ?? 0) + 1;
  return total;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
