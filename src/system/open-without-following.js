import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

// Opens a file without following a final symbolic link. POSIX does this with
// O_NOFOLLOW; Windows has no such flag (Node leaves it undefined, so OR-ing it
// in silently does nothing). There the entry is checked with lstat first and
// the opened handle must be that same file, so a link swapped in between is
// refused too. Junctions report as symbolic links and are refused as well.
export async function openWithoutFollowing(path, flags = constants.O_RDONLY, mode = undefined,
  { noFollow = constants.O_NOFOLLOW, fs = { open, lstat } } = {}) {
  if (noFollow != null) return fs.open(path, flags | noFollow, mode);
  const before = await entry(fs, path, flags);
  const file = await fs.open(path, flags, mode);
  try {
    const after = before ?? await entry(fs, path, 0);
    const opened = await file.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino) throw refused(path);
    return file;
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }
}

async function entry(fs, path, flags) {
  let stat;
  try { stat = await fs.lstat(path, { bigint: true }); } catch (error) {
    // Creating a missing file is allowed; the created entry is checked after opening.
    if (error.code === 'ENOENT' && flags & constants.O_CREAT) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw refused(path);
  return stat;
}

function refused(path) {
  return Object.assign(new Error(`Refusing to open a symbolic link: ${path}`), { code: 'ELOOP' });
}
