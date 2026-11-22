import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// A runner keeps the host's last answer to `fuli whoami` so a script that asks
// while the host is away still learns who owns the project, marked with when
// the answer was given (rec#145, rec#144). Only what the answer already shows:
// space, project and lead names and IDs — never a token or an address.
export const PROJECT_IDENTITY_CACHE_FORMAT = jsonFormat({ store: 'project-identity-cache', versions: [1] });
export const PROJECT_IDENTITY_CACHE_FILE = 'whoami-last-answer.json';
// One entry per folder or project asked about; the oldest go first.
const MAX_ENTRIES = 20;

export function projectIdentityCache(dataDir, { now = () => new Date() } = {}) {
  const path = join(dataDir, PROJECT_IDENTITY_CACHE_FILE);
  const read = () => {
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      return stored?.version === 1 && stored.answers && typeof stored.answers === 'object' ? stored.answers : {};
    } catch {
      // Absent or damaged: there is simply no earlier answer.
      return {};
    }
  };
  return {
    // { at, answer } or null.
    last(key) {
      const entry = read()[key];
      return entry && typeof entry.at === 'string' && entry.answer ? entry : null;
    },
    // Answers whether it was kept: a runner that cannot write still answers now.
    remember(key, answer) {
      const answers = read();
      answers[key] = { at: now().toISOString(), answer };
      const kept = Object.entries(answers).sort(([, a], [, b]) => a.at.localeCompare(b.at)).slice(-MAX_ENTRIES);
      try {
        writeVersionedJsonFileAtomic(path, { version: 1, answers: Object.fromEntries(kept) }, PROJECT_IDENTITY_CACHE_FORMAT);
        return true;
      } catch {
        return false;
      }
    }
  };
}
