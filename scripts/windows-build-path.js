import { resolve } from 'node:path';

// The deepest bundled file lives under runtime\python\Lib\site-packages\, so a
// build root longer than this leaves its path past Windows' 260-character limit.
const MAX_BUILD_PATH_LENGTH = 80;

export function assertShortBuildPath(option, path, suggestion) {
  const resolved = resolve(path);
  if (resolved.length <= MAX_BUILD_PATH_LENGTH) return resolved;
  throw new Error('The ' + option + ' path is too long for Windows: ' + resolved.length
    + ' characters; the limit is ' + MAX_BUILD_PATH_LENGTH + ' characters'
    + '. Use a short directory such as ' + suggestion + '.');
}
