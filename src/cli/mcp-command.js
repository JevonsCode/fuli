import { callAgentTool, listAgentTools } from '../agent-tools.js';
import {
  bindRuntimeLeaseAgentTools,
  createRuntimeLeaseClient
} from '../adaptive-runtime/lease-client.js';
import { ApplicationError } from '../app/application-error.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import {
  GraphRuntimeConfigurationError,
  resolveGraphRuntimeOptions
} from '../graphiti/runtime-config.js';
import { runStdio } from '../mcp/runtime.js';
import { prepareDirectAgentToolCall } from '../mcp/direct-call.js';
import { normalizeMcpSourceApplication } from '../mcp/session-id.js';
import { applicationErrorMessage } from '../mcp/tool-result.js';
import { decodeWorkerDescriptor, WORKER_DESCRIPTOR_ENV } from '../graphiti/worker-descriptor.js';

export async function runMcpCommand(args, { env = process.env } = {}) {
  if (args.includes('--worker') || args.some(arg => arg.startsWith('--worker='))) {
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(helpText());
      return;
    }
    const runtimeArgs = workerRuntimeArguments(args);
    const worker = decodeWorkerDescriptor(env[WORKER_DESCRIPTOR_ENV]);
    const { runtimeConfigPath } = resolveGraphRuntimeOptions(runtimeArgs, env);
    await runStdio({ runtimeConfigPath, worker });
    return;
  }
  if (args.includes('--tools')) {
    process.stdout.write(`${JSON.stringify(listAgentTools(), null, 2)}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(helpText());
    return;
  }

  const { runtimeConfigPath } = resolveGraphRuntimeOptions(args, env);
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
      : undefined,
    // A config without a profile gets the small chat set; full must be asked for.
    toolProfile: args.includes('--tool-profile') ? requiredOption(args, '--tool-profile') : 'chat'
  });
}

function workerRuntimeArguments(args) {
  const seen = new Set(), runtimeArgs = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--worker', '--runtime-config'].includes(flag) || seen.has(flag)) {
      throw new TypeError('Invalid worker MCP options');
    }
    seen.add(flag);
    if (flag === '--runtime-config') {
      const value = args[++index];
      if (!value?.trim() || value.startsWith('-')) throw new TypeError('Invalid worker MCP runtime option');
      runtimeArgs.push(flag, value);
    }
  }
  return runtimeArgs;
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
      () => callAgentTool(app, toolName, prepared.input, prepared.requestContext)
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

export function startupMessage(error) {
  if (error instanceof ApplicationError) return applicationErrorMessage(error);
  if (error instanceof GraphRuntimeConfigurationError) return error.message;
  return 'MCP server failed to start';
}

function helpText() {
  return 'Usage: fuli mcp [--runtime-config <graph-runtime.json>] ' +
    '[--source-application <codex|claude|claude_code|cursor|kiro|opencode|other>] [--tool-profile <full|chat>]\n' +
    '       fuli mcp --tools\n' +
    '       fuli mcp --worker [--runtime-config <graph-runtime.json>]\n' +
    '       Worker mode requires host-only FULI_WORKER_DESCRIPTOR; never pass capabilities in arguments.\n' +
    '       fuli mcp --runtime-config <graph-runtime.json> ' +
    '--call <tool> [--input <json>]\n';
}
