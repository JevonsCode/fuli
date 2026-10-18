#!/usr/bin/env node

import {
  isLocalRuntimeCommand,
  printHelp
} from './cli/command-registry.js';
import { runLocalRuntimeCommand } from './cli/local-runtime-command.js';
import { runRemoteMcpCommand } from './cli/remote-mcp-command.js';
import { runGraphDataCommand } from './cli/graph-data-command.js';
import { runNativeRuntimeCommand } from './cli/native-runtime-command.js';
import { runGraphMigrateCommand } from './cli/graph-migrate-command.js';
import { runEmployeeCommand } from './cli/employee-command.js';
import { runWorkerCommand } from './cli/worker-command.js';
import { runSetupCommand } from './cli/setup-command.js';
import { runConnectCommand } from './cli/connect-command.js';
import { runPeerCommand } from './cli/peer-command.js';
import { runMcpCommand, startupMessage } from './cli/mcp-command.js';
import { runUninstallCommand } from './cli/uninstall-command.js';
import { runUpdateCommand } from './cli/update-command.js';
import { runWorkspaceConnectionCommand } from './cli/workspace-connection-command.js';
import { FULI_VERSION } from './package-metadata.js';
import { isMainModule } from './system/main-module.js';
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
    return runSetupCommand(commandArgs, { env });
  }
  if (command === 'connect') {
    assertSupportedNodeVersion();
    return runConnectCommand(commandArgs, { env });
  }
  if (command === 'peer') {
    assertSupportedNodeVersion();
    return runPeerCommand(commandArgs, { env });
  }
  if (command === 'mcp') {
    assertSupportedNodeVersion();
    try { return await runMcpCommand(commandArgs, { env }); }
    catch (error) { throw new Error(startupMessage(error)); }
  }
  if (command === 'graph') {
    assertSupportedNodeVersion();
    const [action, ...graphArgs] = commandArgs;
    if (action === 'runtime') return runNativeRuntimeCommand(graphArgs, { env });
    if (action === 'migrate') return runGraphMigrateCommand(graphArgs, { env });
    return runGraphDataCommand(action, graphArgs, { env });
  }
  if (command === 'employee') {
    assertSupportedNodeVersion();
    return runEmployeeCommand(commandArgs, { env });
  }
  if (command === 'worker') {
    assertSupportedNodeVersion();
    return runWorkerCommand(commandArgs, { env });
  }
  if (command === 'connect-workspace') {
    assertSupportedNodeVersion();
    return runWorkspaceConnectionCommand(commandArgs, { env });
  }
  if (command === 'remote-mcp') {
    assertSupportedNodeVersion();
    return runRemoteMcpCommand(commandArgs, { env });
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

export { isMainModule };
