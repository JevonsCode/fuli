import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareSemanticVersions, parseSemanticVersion } from '../semantic-version.js';

// What a FULI release says to the person who just updated to it (Jevons 11-08):
// a few short, light lines in Chinese and English about what they will notice,
// never tests, CI or an item-by-item list. Each release ships one small file,
// lines/<version>.json, inside the package, so the console reads it offline.
// A version without a file says nothing. The lines are written when the
// release is cut (docs/development.md › Release); the release workflow runs
// scripts/whats-new-lines.js, which refuses a release without them.

export const RELEASE_LINES_DIR = fileURLToPath(new URL('./lines/', import.meta.url));
export const MAX_LINE_LENGTH = 100;
export const MAX_LINES = 5;
export const LINE_LANGUAGES = Object.freeze(['zh', 'en']);
const RELEASE_PAGE = 'https://github.com/JevonsCode/fuli/releases/tag/';

export const releasePageUrl = (version) => `${RELEASE_PAGE}v${version}`;

// Everything wrong with one version's file, in words a release author can fix; empty when it is fine.
export function releaseLinesProblems(record, version) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['the file must hold one JSON object'];
  const problems = [];
  if (record.version !== version) problems.push(`version must be "${version}", the file's own name`);
  for (const language of LINE_LANGUAGES) {
    const lines = record[language];
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) {
      problems.push(`${language} needs 1 to ${MAX_LINES} lines`);
      continue;
    }
    lines.forEach((line, index) => {
      if (typeof line !== 'string' || !line.trim()) problems.push(`${language}[${index}] is empty`);
      else if ([...line].length > MAX_LINE_LENGTH) problems.push(`${language}[${index}] is longer than ${MAX_LINE_LENGTH} characters`);
      else if (/\n/.test(line)) problems.push(`${language}[${index}] must be one line`);
    });
  }
  const extra = Object.keys(record).filter((key) => key !== 'version' && !LINE_LANGUAGES.includes(key));
  if (extra.length) problems.push(`unknown fields: ${extra.join(', ')}`);
  return problems;
}

// One version's lines, or null when the package has none (or they are not readable).
export function readReleaseLines(version, { dir = RELEASE_LINES_DIR } = {}) {
  const file = join(dir, `${version}.json`);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (releaseLinesProblems(record, version).length) return null;
    return { version, zh: [...record.zh], en: [...record.en] };
  } catch {
    return null;
  }
}

// Every version the package carries lines for, oldest first.
export function shippedLineVersions({ dir = RELEASE_LINES_DIR } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((version) => { try { parseSemanticVersion(version); return true; } catch { return false; } })
    .sort(compareSemanticVersions);
}
