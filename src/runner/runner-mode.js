import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Whether a data directory belongs to a runner (docs/runner.md): it paired
// with a host and has no graph runtime of its own. The MCP entry then serves
// through the host and lifecycle hooks do nothing. Only Node built-ins load
// here: the thin hook entry decides with it before loading anything else.
const RUNNER_STORE = join('runner', 'runner.sqlite');

function isRunnerDataDirectory(dataDir) {
  return existsSync(join(dataDir, RUNNER_STORE)) && !existsSync(join(dataDir, 'graph-runtime.json'));
}

// The same, for a hook or MCP command line naming --runtime-config.
export function runnerRuntimeConfig(argv) {
  const index = argv.indexOf('--runtime-config');
  const configPath = index >= 0 ? argv[index + 1] : null;
  return typeof configPath === 'string' && configPath ? isRunnerDataDirectory(dirname(resolve(configPath))) : false;
}
