#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { dispatchCommand, isRegisteredCommand, printHelp } from './cli/command-registry.js';
import { parseCliInvocation } from './cli/invocation.js';
import { migrateLegacyJson } from './cli/migrate-command.js';
import { runSetupCommand } from './cli/setup-command.js';
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
  if (command === 'migrate') {
    if (runtimeArgs.length) resolveRuntimeOptions(runtimeArgs, {});
    console.log(JSON.stringify(migrateLegacyJson(commandArgs)));
    return;
  }
  if (command === 'setup') {
    if (runtimeArgs.length) {
      throw new TypeError('Setup options must appear after the setup command');
    }
    await runSetupCommand(commandArgs, { env });
    return;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
