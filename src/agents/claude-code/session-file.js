import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_PROJECT_ENTRIES = 512;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude's projects/<encoded-cwd>/<session>.jsonl layout. A bounded, unique
// filename match only locates a candidate; the evidence reader checks its
// native session and complete records. Symlinks and partial scans prove none.
export async function locateClaudeSession(sessionId, projectsDirectory) {
  if (!SESSION.test(sessionId)) return null;
  try {
    if (!(await lstat(projectsDirectory)).isDirectory()) return null;
    const directory = await opendir(projectsDirectory);
    let found = null, entries = 0;
    for await (const entry of directory) {
      if (++entries > MAX_PROJECT_ENTRIES) return null;
      if (!entry.isDirectory()) continue;
      const path = join(projectsDirectory, entry.name, `${sessionId}.jsonl`);
      try {
        if (!(await lstat(path)).isFile()) continue;
        if (found) return null;
        found = path;
      } catch (error) {
        if (error.code !== 'ENOENT') return null;
      }
    }
    return found;
  } catch { return null; }
}
