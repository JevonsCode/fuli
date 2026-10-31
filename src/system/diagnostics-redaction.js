// What a diagnostics bundle (diagnostics-bundle.js) hides before anything
// leaves this computer. Each rule replaces what it finds with a placeholder
// and counts it, so the person sees how much was hidden and of which kind.
// Rules run in this order: a home directory before the username it contains,
// URLs and named keys before the long-secret rule that would also match them.

export const REDACTION_KINDS = Object.freeze([
  'home_directory', 'url_credentials', 'url_query', 'bearer_token', 'api_key',
  'secret_assignment', 'email', 'long_secret', 'username'
]);

// A username shorter than this is too common a word to hide everywhere.
const MIN_USERNAME_LENGTH = 3;

const URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>@]+@)?([^\s?#"'<>]*)(\?[^\s#"'<>]*)?/gi;
const BEARER_PATTERN = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const API_KEY_PATTERN = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g;
// A value under a name that says it is secret: password=…, "api_key": "…", token: ….
const SECRET_ASSIGNMENT_PATTERN = /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)"?\s*[:=]\s*"?)(?!null\b|true\b|false\b|<)([^\s"',;}&]{4,})/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// 32+ hex digits, or 40+ base64/url-safe characters mixing letters and digits.
// A slash ends a run, so a path is never hidden whole, only its long segments.
const LONG_SECRET_PATTERN = /(?<![A-Za-z0-9_+=-])(?:[A-Fa-f0-9]{32,}|(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+-]{40,}={0,2})(?![A-Za-z0-9_+=-])/g;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// homeDir and username are this computer's; both are hidden wherever they appear,
// in either slash direction and in JSON's escaped form, regardless of case.
export function createRedactor({ homeDir, username }) {
  const counts = Object.fromEntries(REDACTION_KINDS.map((kind) => [kind, 0]));
  const homePattern = homeDirPattern(homeDir);
  const userPattern = typeof username === 'string' && username.length >= MIN_USERNAME_LENGTH
    ? new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(username)}(?![A-Za-z0-9])`, 'gi') : null;

  const replace = (text, pattern, kind, replacement) => text.replace(pattern, (...match) => {
    counts[kind] += 1;
    return typeof replacement === 'function' ? replacement(...match) : replacement;
  });

  function redact(text) {
    let shown = homePattern ? replace(text, homePattern, 'home_directory', '~') : text;
    shown = shown.replace(URL_PATTERN, (_, scheme, credentials, rest, query) => {
      if (credentials) counts.url_credentials += 1;
      if (query) counts.url_query += 1;
      return `${scheme}${credentials ? '<credentials>@' : ''}${rest}${query ? '?<redacted>' : ''}`;
    });
    shown = replace(shown, BEARER_PATTERN, 'bearer_token', (_, scheme, space) => `${scheme}${space}<token>`);
    shown = replace(shown, API_KEY_PATTERN, 'api_key', '<api-key>');
    shown = replace(shown, SECRET_ASSIGNMENT_PATTERN, 'secret_assignment', (_, name) => `${name}<secret>`);
    shown = replace(shown, EMAIL_PATTERN, 'email', '<email>');
    shown = replace(shown, LONG_SECRET_PATTERN, 'long_secret', '<secret>');
    return userPattern ? replace(shown, userPattern, 'username', '<user>') : shown;
  }

  return { redact, counts: () => ({ ...counts }) };
}

function homeDirPattern(homeDir) {
  if (typeof homeDir !== 'string' || !homeDir.replace(/[\\/]+$/, '')) return null;
  const home = homeDir.replace(/[\\/]+$/, '');
  const forms = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\'), home.replaceAll('\\', '\\\\')]);
  const alternatives = [...forms].sort((left, right) => right.length - left.length).map(escapeRegExp);
  return new RegExp(`(?:${alternatives.join('|')})(?![A-Za-z0-9_.-])`, 'gi');
}
