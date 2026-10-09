// Discover the effective MCP configuration, then disable and verify every entry.
// Empty TOML tables merge recursively and cannot clear inherited servers.
export async function prepareCodexRoundtableConfig({ command, workspace, env, signal, runProcess,
  platform = process.platform }) {
  const options = ['--disable', 'plugins', '--disable', 'apps', '--disable', 'multi_agent',
    '-c', 'hooks.enabled=false', '-c', 'notify=[]', '-c', 'project_doc_max_bytes=0',
    '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'approval_policy="never"', '-c', 'approvals_reviewer="user"',
    '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
    ...(platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : [])];
  const list = async (overrides) => {
    const result = await runProcess(command, ['mcp', 'list', '--json', ...overrides],
      { cwd: workspace, env, signal, timeoutMs: 10000 });
    if (result.code !== 0) throw isolationFailure();
    let servers;
    try { servers = JSON.parse(result.stdout); } catch { throw isolationFailure(); }
    if (!Array.isArray(servers) || servers.length > 100 || servers.some(server =>
      !server || !/^[A-Za-z0-9_-]{1,128}$/.test(server.name) || typeof server.enabled !== 'boolean')) throw isolationFailure();
    return servers;
  };
  const servers = await list(options);
  for (const server of servers) options.push('-c', `mcp_servers.${server.name}.enabled=false`);
  if ((await list(options)).some(server => server.enabled)) throw isolationFailure();
  return options;
}

function isolationFailure() {
  return Object.assign(new Error('Codex effective MCP isolation could not be verified'), { code: 'runtime_isolation_failed' });
}
