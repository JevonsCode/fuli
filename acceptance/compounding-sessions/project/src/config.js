import { readFileSync } from 'node:fs';

const ports = JSON.parse(readFileSync(new URL('../config/ports.json', import.meta.url), 'utf8'));

export function environment() {
  return process.env.TIDE_ENV ?? 'dev';
}

export function port(env = environment()) {
  if (!(env in ports)) throw new Error(`No port configured for environment "${env}"`);
  return ports[env];
}
