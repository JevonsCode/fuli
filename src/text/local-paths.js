// A file-system path of this computer inside text: a drive path, a UNC share,
// or a POSIX path under a home, mount or system directory. Text that leaves
// this computer's own process (a diagnostic event, a visitor's search answer)
// names no such path.
const LOCAL_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\|(?<![\w.])\/(?:home|Users|mnt|root|tmp|var|private)\/)[^\s'"]*/g;

export function withoutLocalPaths(text) {
  return text.replace(LOCAL_PATH, '[path]');
}
