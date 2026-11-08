import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_LINES_DIR, releaseLinesProblems } from '../src/whats-new/release-lines.js';

// Checks the what's-new lines the package ships (src/whats-new/release-lines.js).
//   node scripts/whats-new-lines.js            every file is valid
//   node scripts/whats-new-lines.js --release  and the package's own version has one
// The release workflow runs --release, so a release cannot go out without its lines.
export function checkWhatsNewLines({ dir = RELEASE_LINES_DIR, requireVersion = null } = {}) {
  const problems = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
  for (const name of files) {
    const version = name.slice(0, -'.json'.length);
    let record;
    try { record = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch (error) {
      problems.push(`${name}: not JSON (${error.message})`);
      continue;
    }
    for (const problem of releaseLinesProblems(record, version)) problems.push(`${name}: ${problem}`);
  }
  if (requireVersion && !files.includes(`${requireVersion}.json`)) {
    problems.push(`${requireVersion}.json is missing: write ${requireVersion}'s what's-new lines in src/whats-new/lines/ (docs/development.md › Release)`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const problems = checkWhatsNewLines({ requireVersion: process.argv.includes('--release') ? manifest.version : null });
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exitCode = 1;
}
