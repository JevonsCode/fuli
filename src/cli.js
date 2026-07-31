#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isLocalRuntimeCommand,
  printHelp
} from './cli/command-registry.js';
import { runLocalRuntimeCommand } from './cli/local-runtime-command.js';
import { runSetupCommand } from './cli/setup-command.js';
import { runUninstallCommand } from './cli/uninstall-command.js';
import { runUpdateCommand } from './cli/update-command.js';
import { FULI_VERSION } from './package-metadata.js';
import { assertSupportedNodeVersion } from './setup/node-runtime.js';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...commandArgs] = argv;
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(FULI_VERSION);
    return;
  }
  if (command === 'setup') {
    assertSupportedNodeVersion();
    await runSetupCommand(commandArgs, { env });
    return;
  }
  if (command === 'uninstall') {
    await runUninstallCommand(commandArgs, { env });
    return;
  }
  if (command === 'update') {
    assertSupportedNodeVersion();
    return runUpdateCommand(commandArgs, { env });
  }
  if (isLocalRuntimeCommand(command)) {
    return runLocalRuntimeCommand(command, commandArgs, { env });
  }
  throw new Error(`Unknown command: ${command}`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main()
    .then((result) => {
      if (Number.isInteger(result?.exitCode)) process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

export function isMainModule(metaUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvPath);
  } catch {
    return fileURLToPath(metaUrl) === argvPath;
  }
}
