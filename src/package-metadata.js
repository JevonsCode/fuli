import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const FULI_PACKAGE_NAME = manifest.name;
export const FULI_VERSION = manifest.version;
