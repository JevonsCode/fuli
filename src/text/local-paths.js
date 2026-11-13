// A file-system path of this computer inside text. Text that leaves this
// computer's own process (a diagnostic event, a visitor's search answer)
// names no such path; when unsure, more is replaced rather than less.
//
// A Windows or home path may hold spaces inside a folder name: a segment
// followed by another separator is part of the path whatever it contains
// (C:\Users\First Last\file.txt), only the last segment ends at a space.
const SEGMENTS = String.raw`(?:[^\\/\r\n"'<>|*?]*[\\/])*[^\s\\/"'<>|*?]*`;
const NOT_INSIDE = String.raw`(?<![\w.:/\\~-])`;
const pattern = (posixRoot) => new RegExp([
  // file: URLs, whole.
  String.raw`\bfile:[^\s"'<>]*`,
  // Drive paths (C:\ or C:/) and UNC shares (\\server\share).
  String.raw`\b[A-Za-z]:[\\/]${SEGMENTS}`,
  String.raw`\\\\${SEGMENTS}`,
  // Home and relative paths that name a folder: ~/…, ./…, ../…
  String.raw`(?<![\w.~])(?:~|\.{1,2})[\\/]${SEGMENTS}`,
  // POSIX absolute paths, not inside a word, URL or other path.
  String.raw`${NOT_INSIDE}\/${posixRoot}[^\s"'<>]*`
].join('|'), 'gi');
// Any root: what a visitor reads names no path at all.
const ANY_ROOT = pattern(String.raw`[^\s/"'<>]+`);
// Home, mount and system roots only: a diagnostic's operation names the
// console's own routes (POST /api/…), which are no path of this computer.
const SYSTEM_ROOT = pattern('(?:home|Users|mnt|root|tmp|var|private|etc|opt|Volumes|usr|srv|media|run)(?:/|\\b)');

const PATTERNS = Object.freeze({ any: ANY_ROOT, system: SYSTEM_ROOT });

// posixRoots: 'any' (default) or 'system'.
export function withoutLocalPaths(text, { posixRoots = 'any' } = {}) {
  return text.replace(PATTERNS[posixRoots], '[path]');
}
