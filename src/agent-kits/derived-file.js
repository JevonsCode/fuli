import { readFileSync } from 'node:fs';

import { writeTextFileAtomic } from '../storage/json-file.js';

// The files FULI hands the shared client components (the launcher's host
// configuration, the installer's product manifest) are derived from FULI's
// own settings and packs, never FULI data: they are rewritten only when their
// text changes, so the components, which reread them on every call, never see
// a needless replace.
export function writeDerivedJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let current = null;
  try { current = readFileSync(path, 'utf8'); } catch { /* absent: written below */ }
  if (current !== text) writeTextFileAtomic(path, text);
}
