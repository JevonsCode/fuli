#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { DEFAULT_FULI_PORT } from '../defaults.js';
import { ensureGraphRuntime } from '../setup/graph-runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';

export async function main(args = process.argv.slice(2), env = process.env) {
  const paths = resolveSetupPaths({ dataDir: option(args, '--data-dir'), env });
  const result = await ensureGraphRuntime({
    paths,
    personalSpaceName: option(args, '--personal-space') ?? '我',
    port: numberOption(args, '--port', DEFAULT_FULI_PORT),
    personalOnly: args.includes('--personal-only'),
    noStart: args.includes('--no-start')
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function option(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${flag}`);
  return value;
}

function numberOption(args, flag, fallback) {
  const value = option(args, flag);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${flag} must be a positive integer`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
