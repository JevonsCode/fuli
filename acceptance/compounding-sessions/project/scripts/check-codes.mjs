// Every TW-<AREA>-<NNN> code used under src/ must be listed in docs/error-codes.md.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path) : path.endsWith('.js') ? [path] : [];
});
const used = new Set(files(join(root, 'src')).flatMap((file) => readFileSync(file, 'utf8').match(/TW-[A-Z]+-\d{3}/g) ?? []));
const listed = readFileSync(join(root, 'docs', 'error-codes.md'), 'utf8');
const missing = [...used].filter((code) => !listed.includes(code)).sort();
if (missing.length) {
  console.error(`error codes used in src/ but missing from docs/error-codes.md: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`ok: ${used.size} error codes listed`);
