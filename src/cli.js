#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  dispatchCommand,
  isLocalRuntimeCommand,
  isRegisteredCommand,
  printHelp
} from './cli/command-registry.js';
import { parseCliInvocation } from './cli/invocation.js';
import { runLocalRuntimeCommand } from './cli/local-runtime-command.js';
import { migrateLegacyJson } from './cli/migrate-command.js';
import { runSetupCommand } from './cli/setup-command.js';
import { runUninstallCommand } from './cli/uninstall-command.js';
import { runUpdateCommand } from './cli/update-command.js';
import { FULI_VERSION } from './package-metadata.js';
import { assertSupportedNodeVersion } from './setup/node-runtime.js';
import {
  openLocalApplication,
  resolveRuntimeOptions
} from './runtime-options.js';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { runtimeArgs, command, args: commandArgs } = parseCliInvocation(argv);
  if (!command || command === '--help' || command === '-h') {
    if (runtimeArgs.length) resolveRuntimeOptions(runtimeArgs, {});
    printHelp();
    return;
  }
  if (command === '--version' || command === '-v') {
    if (runtimeArgs.length) resolveRuntimeOptions(runtimeArgs, {});
    console.log(FULI_VERSION);
    return;
  }
  if (command === 'migrate') {
    if (runtimeArgs.length) resolveRuntimeOptions(runtimeArgs, {});
    console.log(JSON.stringify(migrateLegacyJson(commandArgs)));
    return;
  }
  if (command === 'setup') {
    if (runtimeArgs.length) {
      throw new TypeError('Setup options must appear after the setup command');
    }
    assertSupportedNodeVersion();
    await runSetupCommand(commandArgs, { env });
    return;
  }
  if (command === 'uninstall') {
    if (runtimeArgs.length) {
      throw new TypeError('Uninstall options must appear after the uninstall command');
    }
    await runUninstallCommand(commandArgs, { env });
    return;
  }
  if (command === 'update') {
    if (runtimeArgs.length) {
      throw new TypeError('Update options must appear after the update command');
    }
    assertSupportedNodeVersion();
    return runUpdateCommand(commandArgs, { env });
  }
  if (isLocalRuntimeCommand(command)) {
    if (runtimeArgs.length) {
      throw new TypeError(`${command} options must appear after the command`);
    }
    return runLocalRuntimeCommand(command, commandArgs, { env });
  }
  if (!isRegisteredCommand(command)) throw new Error(`Unknown command: ${command}`);

  const options = resolveRuntimeOptions(runtimeArgs, env);
  const app = openLocalApplication(options);
  try {
    dispatchCommand(app, command, commandArgs);
  } finally {
    app.close();
  }
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
