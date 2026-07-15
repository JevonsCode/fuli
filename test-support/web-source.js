import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = 'web';

export function readWebFile(path) {
  return readFileSync(join(WEB_ROOT, path), 'utf8');
}

export function webSource(...paths) {
  return paths.map(readWebFile).join('\n');
}
