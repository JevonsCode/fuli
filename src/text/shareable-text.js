import { redactSensitiveContent } from '../security/sensitive-content.js';
import { withoutLocalPaths } from './local-paths.js';

// Text that leaves this computer's own process (a diagnostic event, a
// visitor's search answer): local paths replaced, URL credentials dropped and
// query values masked, PEM blocks, known secrets and long opaque values
// (tokens, signed ids) replaced. When unsure, more is replaced rather than less.
// Userinfo is everything up to the last @ before the host's path, query or
// fragment, so a password holding @ or : goes with it.
const URL_WITH_PARTS = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#]*@)?([^\s?#]*)(\?[^\s#]*)?(#\S*)?/gi;
// A query pair outside a URL (?token=…, &key=…).
const QUERY_PAIR = /([?&][A-Za-z_][\w.-]*=)[^\s&#]*/g;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const OPAQUE_VALUE = /\b[A-Za-z0-9_-]{32,}\b/g;

// mode: how far a local path reaches (withoutLocalPaths), 'strict' by default.
export function shareableText(text, { mode = 'strict' } = {}) {
  const masked = withoutLocalPaths(text.replace(PEM_BLOCK, '[redacted:pem]'), { mode })
    .replace(URL_WITH_PARTS, (_url, scheme, rest, query = '') =>
      `${scheme}${rest}${query && `?${query.slice(1).split('&').map(pair => `${pair.split('=')[0]}=…`).join('&')}`}`)
    .replace(QUERY_PAIR, '$1…');
  return redactSensitiveContent(masked).replace(OPAQUE_VALUE, '[redacted:opaque]');
}
