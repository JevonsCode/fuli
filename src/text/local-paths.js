// A file-system path of this computer inside text. Text that leaves this
// computer's own process (a diagnostic event, a visitor's search answer)
// names no such path; when unsure, more is replaced rather than less.
//
// A folder name may hold spaces: a segment followed by another separator is
// part of the path whatever it contains (C:\Users\First Last\file.txt).
//
// mode 'strict' (the default, a visitor's answer) also follows spaces in the
// last segment, preferring to replace too much:
// - every absolute POSIX path counts, under any root;
// - a drive or UNC path runs to the end of its line or quoted string
//   (C:\Users\Alice\Private Repo);
// - a POSIX, home or relative path takes the following words on its line up
//   to the last one, within eight, that holds a separator or ends in a dot
//   extension (/home/alice/my folder/file.txt); when its last segment begins
//   with a capital or a digit, also up to eight capitalised words or numbers
//   right after it, unless it ends a sentence (/home/alice/Secret Plans 2);
//   other words after it stay (see /opt/app for details, /usr/bin I think);
//   known limit: a lower-case segment's tail stays (/home/alice/secret Plans);
// - such a path, or a file: URL, right after a quote or backtick runs to the
//   same mark on its line ("/home/alice/secret plans"); a file: URL follows
//   the capitalised words like a POSIX path;
// - closing punctuation after these paths stays, outside the replacement
//   ([path], then).
// mode 'keep-routes' (a diagnostic event) treats only home, mount and system
// roots as POSIX paths and follows no spaces after the path: its operations
// name the console's own routes (POST /api/tasks) and the prose after them.
// In both modes a quote, backtick or angle bracket ends a path.
const SEGMENTS = String.raw`(?:[^\\/\r\n"'\x60<>|*?]*[\\/])*[^\s\\/"'\x60<>|*?]*`;
const WORD = String.raw`[^\s"'\x60<>]`;
const PATH_WORDS = String.raw`(?:(?:[ \t]${WORD}+){0,7}?[ \t]${WORD}*?(?:[\\/]|\.[A-Za-z0-9]{1,8}(?!\w))${WORD}*)*`;
const TO_LINE_END = String.raw`[^\r\n"'\x60<>|]*`;
const FILE_URL = String.raw`\bfile:[^\s"'\x60<>]*`;
const HOME_OR_RELATIVE = String.raw`(?<![\w.~])(?:~|\.{1,2})[\\/]${SEGMENTS}`;
const POSIX = String.raw`(?<![\w.:/\\~-])\/`;
const SYSTEM_ROOTS = '(?:home|Users|mnt|root|tmp|var|private|etc|opt|Volumes|usr|srv|media|run)(?:/|\\b)';
const QUOTES = new Set(['"', '\'', '`']);
const MAX_PATH_WORDS = 8;
// A following word that continues a path in strict mode: capitalised or a number.
const CAPITALISED_WORD = new RegExp(String.raw`[ \t]+[\p{Lu}\p{N}]${WORD}*`, 'uy');
const CAPITALISED = /[\p{Lu}\p{N}]/u;
// Punctuation that closes a sentence or a bracket after a path.
const CLOSING_MARKS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);
const LINE_BREAKS = new Set(['\r', '\n']);

const PATTERNS = Object.freeze({
  strict: new RegExp([
    String.raw`\b[A-Za-z]:[\\/]${TO_LINE_END}`,
    String.raw`\\\\${TO_LINE_END}`,
    `(?<words>${FILE_URL}|${HOME_OR_RELATIVE}${PATH_WORDS}|${POSIX}[^\\s/"'\`<>]+[^\\s"'\`<>]*${PATH_WORDS})`
  ].join('|'), 'gi'),
  'keep-routes': new RegExp([
    FILE_URL,
    String.raw`\b[A-Za-z]:[\\/]${SEGMENTS}`,
    String.raw`\\\\${SEGMENTS}`,
    HOME_OR_RELATIVE,
    String.raw`${POSIX}${SYSTEM_ROOTS}[^\s"'\x60<>]*`
  ].join('|'), 'gi')
});

export function withoutLocalPaths(text, { mode = 'strict' } = {}) {
  const pattern = new RegExp(PATTERNS[mode]);
  let shown = '';
  let from = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = match.groups?.words === undefined ? pattern.lastIndex : pathWordsEnd(text, match.index, pattern.lastIndex);
    shown += `${text.slice(from, match.index)}[path]`;
    from = end;
    pattern.lastIndex = Math.max(end, match.index + 1);
  }
  return shown + text.slice(from);
}

// Where a strict file: URL, POSIX, home or relative path that the pattern
// matched from start to end really ends (see the rules above). Each loop only
// walks characters no later match walks again, so long input stays linear.
function pathWordsEnd(text, start, end) {
  const opener = text[start - 1];
  if (QUOTES.has(opener)) {
    for (let at = end; at < text.length && !LINE_BREAKS.has(text[at]); at += 1) if (text[at] === opener) return at;
  }
  let reached = end;
  if (CAPITALISED.test(text[lastSegmentStart(text, start, end)] ?? '')) {
    for (let words = 0; words < MAX_PATH_WORDS && !CLOSING_MARKS.has(text[reached - 1]); words += 1) {
      CAPITALISED_WORD.lastIndex = reached;
      if (!CAPITALISED_WORD.test(text)) break;
      reached = CAPITALISED_WORD.lastIndex;
    }
  }
  while (reached > start + 1 && CLOSING_MARKS.has(text[reached - 1])) reached -= 1;
  return reached;
}

function lastSegmentStart(text, start, end) {
  let at = end;
  while (at > start && text[at - 1] !== '/' && text[at - 1] !== '\\') at -= 1;
  return at;
}
