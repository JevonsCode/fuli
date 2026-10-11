import { resolveSetupPaths } from '../setup/paths.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { clientConnectionConfig } from '../setup/client-connection.js';

export function runConnectCommand(args, { env = process.env, write = console.log } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    write('fuli connect [--format standard|vscode|server] [--profile full|chat] [--source-application codex|claude|claude_code|cursor|kiro|other] [--data-dir DIR | --runtime-config FILE]\nPrint local MCP configuration; merge the fuli entry into your client settings. No files are changed.\nUse --profile chat for chat apps that load every tool into each conversation. fuli setup configures Claude Desktop automatically.');
    return;
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!['--format', '--profile', '--source-application', '--data-dir', '--runtime-config'].includes(flag)) throw new TypeError(`Unknown connect option: ${flag}`);
    if (options.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    const value = args[index + 1];
    if (!value?.trim() || value.startsWith('--')) throw new TypeError(`Missing value for ${flag}`);
    options.set(flag, value);
  }
  if (options.has('--data-dir') && options.has('--runtime-config')) {
    throw new TypeError('Choose --data-dir or --runtime-config, not both');
  }
  const paths = resolveSetupPaths({ dataDir: options.get('--data-dir'), env });
  const runtimeConfigPath = options.has('--data-dir') ? paths.graphRuntimeConfigPath
    : resolveGraphRuntimeOptions(options.has('--runtime-config') ? ['--runtime-config', options.get('--runtime-config')] : [], env).runtimeConfigPath;
  const config = clientConnectionConfig({ mcpServerPath: paths.mcpServerPath, runtimeConfigPath }, options.get('--format'), {
    profile: options.get('--profile') ?? 'full',
    sourceApplication: options.get('--source-application') ?? 'other'
  });
  write(JSON.stringify(config, null, 2));
  return config;
}
