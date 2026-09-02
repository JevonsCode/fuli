#!/usr/bin/env node
import { callAgentTool, listAgentTools } from './agent-tools.js';
import {
  bindRuntimeLeaseAgentTools,
  createRuntimeLeaseClient
} from './adaptive-runtime/lease-client.js';
import { ApplicationError } from './app/application-error.js';
import { openFederatedGraphApplication } from './graphiti/federated-application.js';
import {
  GraphRuntimeConfigurationError,
  resolveGraphRuntimeOptions
} from './graphiti/runtime-config.js';
import { runStdio } from './mcp/runtime.js';
import { prepareDirectAgentToolCall } from './mcp/direct-call.js';
import { normalizeMcpSourceApplication } from './mcp/session-id.js';
import { applicationErrorMessage } from './mcp/tool-result.js';

await main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${startupMessage(error)}\n`);
  process.exitCode = 1;
});

async function main(args) {
  if (args.includes('--tools')) {
    process.stdout.write(`${JSON.stringify(listAgentTools(), null, 2)}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(helpText());
    return;
  }

  const { runtimeConfigPath } = resolveGraphRuntimeOptions(args, process.env);
  const configuredSourceApplication = args.includes('--source-application')
    ? requiredOption(args, '--source-application')
    : null;
  if (args.includes('--call')) {
    await runCall({
      args,
      runtimeConfigPath,
      sourceApplication: configuredSourceApplication
        ? normalizeMcpSourceApplication(configuredSourceApplication)
        : 'other'
    });
    return;
  }
  await runStdio({
    runtimeConfigPath,
    sourceApplication: configuredSourceApplication
      ? normalizeMcpSourceApplication(configuredSourceApplication)
      : undefined
  });
}

async function runCall({ args, runtimeConfigPath, sourceApplication }) {
  const toolName = requiredOption(args, '--call');
  const prepared = await prepareDirectAgentToolCall({
    toolName,
    input: parseInput(args),
    sourceApplication
  });
  const app = openFederatedGraphApplication({ runtimeConfigPath });
  const leaseClient = createRuntimeLeaseClient({ runtimeConfigPath });
  bindRuntimeLeaseAgentTools(app, leaseClient);
  try {
    const result = await leaseClient.withGraphLease(
      `cli-call:${toolName}`,
      () => callAgentTool(app, toolName, prepared.input)
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await leaseClient.close();
    await app.close();
  }
}

function option(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function requiredOption(args, flag) {
  const value = option(args, flag);
  if (!value) throw new TypeError(`Missing value for ${flag}`);
  return value;
}

function parseInput(args) {
  const raw = option(args, '--input');
  return raw ? JSON.parse(raw) : {};
}

function startupMessage(error) {
  if (error instanceof ApplicationError) return applicationErrorMessage(error);
  if (error instanceof GraphRuntimeConfigurationError) return error.message;
  return 'MCP server failed to start';
}

function helpText() {
  return 'Usage: node src/mcp-server.js [--runtime-config <graph-runtime.json>] ' +
    '[--source-application <codex|claude|claude_code|cursor|kiro|other>]\n' +
    '       node src/mcp-server.js --tools\n' +
    '       node src/mcp-server.js --runtime-config <graph-runtime.json> ' +
    '--call <tool> [--input <json>]\n';
}
