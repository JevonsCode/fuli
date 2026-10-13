import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Content-addressed so identical guidance keeps one stable path across turns
// and sessions; a changed rule set produces a new file instead of rewriting.
export function writeGuidanceFile(directory, markdown) {
  const digest = createHash('sha256').update(markdown).digest('hex').slice(0, 16);
  const path = join(directory, `task-guidance-${digest}.md`);
  if (!existsSync(path)) {
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, markdown, { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(temporary, path);
    } catch (error) {
      // A concurrent hook may have written the same content first.
      rmSync(temporary, { force: true });
      if (!existsSync(path)) throw error;
    }
  }
  return { path, digest };
}
