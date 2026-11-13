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
//   extension (/home/alice/my folder/file.txt); words after it that do neither
//   stay (see /opt/app for details).
// mode 'keep-routes' (a diagnostic event) treats only home, mount and system
// roots as POSIX paths and follows no spaces after the path: its operations
// name the console's own routes (POST /api/tasks) and the prose after them.
const SEGMENTS = String.raw`(?:[^\\/\r\n"'<>|*?]*[\\/])*[^\s\\/"'<>|*?]*`;
const WORD = String.raw`[^\s"'<>]`;
const PATH_WORDS = String.raw`(?:(?:[ \t]${WORD}+){0,7}?[ \t]${WORD}*?(?:[\\/]|\.[A-Za-z0-9]{1,8}(?!\w))${WORD}*)*`;
const TO_LINE_END = String.raw`[^\r\n"'<>|]*`;
const FILE_URL = String.raw`\bfile:[^\s"'<>]*`;
const HOME_OR_RELATIVE = String.raw`(?<![\w.~])(?:~|\.{1,2})[\\/]${SEGMENTS}`;
const POSIX = String.raw`(?<![\w.:/\\~-])\/`;
const SYSTEM_ROOTS = '(?:home|Users|mnt|root|tmp|var|private|etc|opt|Volumes|usr|srv|media|run)(?:/|\\b)';

const PATTERNS = Object.freeze({
  strict: new RegExp([
    FILE_URL,
    String.raw`\b[A-Za-z]:[\\/]${TO_LINE_END}`,
    String.raw`\\\\${TO_LINE_END}`,
    `${HOME_OR_RELATIVE}${PATH_WORDS}`,
    String.raw`${POSIX}[^\s/"'<>]+[^\s"'<>]*${PATH_WORDS}`
  ].join('|'), 'gi'),
  'keep-routes': new RegExp([
    FILE_URL,
    String.raw`\b[A-Za-z]:[\\/]${SEGMENTS}`,
    String.raw`\\\\${SEGMENTS}`,
    HOME_OR_RELATIVE,
    String.raw`${POSIX}${SYSTEM_ROOTS}[^\s"'<>]*`
  ].join('|'), 'gi')
});

export function withoutLocalPaths(text, { mode = 'strict' } = {}) {
  return text.replace(PATTERNS[mode], '[path]');
}
