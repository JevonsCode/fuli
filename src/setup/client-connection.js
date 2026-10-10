// Configuration only: no client discovery, file writes, credentials or model calls.
export function clientConnectionConfig({ nodePath = process.execPath, mcpServerPath, runtimeConfigPath }, format = 'standard') {
  if (!['standard', 'vscode', 'server'].includes(format)) {
    throw new TypeError('Connection format must be standard, vscode or server');
  }
  for (const value of [nodePath, mcpServerPath, runtimeConfigPath]) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Connection paths are required');
  }
  const server = {
    type: 'stdio',
    command: nodePath,
    args: [mcpServerPath, '--runtime-config', runtimeConfigPath, '--source-application', 'other']
  };
  if (format === 'server') return server;
  return { [format === 'vscode' ? 'servers' : 'mcpServers']: { fuli: server } };
}
