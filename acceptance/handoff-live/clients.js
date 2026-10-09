import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './process.js';

export function clientEvidence(application, result) {
  const events = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const tools = [], answers = [];
  let sessionId, usage, error = result.error;
  for (const event of events) {
    sessionId ??= event.thread_id ?? event.session_id;
    if (application === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
        tools.push({ name: event.item.tool, status: event.item.status,
          succeeded: event.item.status === 'completed' && !event.item.error && !event.item.result?.isError });
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') answers.push(event.item.text);
      if (event.type === 'turn.completed') usage = event.usage;
      if (event.type === 'turn.failed' || event.type === 'error') error = 'client_error';
    } else {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') tools.push({ name: block.name, id: block.id });
        if (block.type === 'tool_result') {
          const call = tools.find(tool => tool.id === block.tool_use_id);
          if (call) call.succeeded = !block.is_error;
        }
      }
      if (event.type === 'result') {
        if (event.result) answers.push(event.result);
        usage = event.usage;
        if (event.is_error) error = /401|not logged in|authenticate|invalid.api.key/i.test(event.result ?? '')
          ? 'authentication_failed' : 'client_error';
      }
    }
  }
  return { application, sessionId, exitCode: result.code, error,
    tools: tools.map(({ id, ...tool }) => tool), answer: answers.join('\n'), usage: usage ? { source: 'executor', ...usage } : null };
}

// Never publish free-form model output, upstream errors or transcripts. The runner
// proves recall against the generated marker in memory, then publishes booleans.
export function publicClientEvidence(client) {
  const { application, sessionId, exitCode, tools, usage } = client;
  const error = client.error ? (client.error === 'authentication_failed' ? 'authentication_failed' : 'client_error') : undefined;
  return { application, sessionId, exitCode, error, tools, usage };
}

export async function runClient(application, fixture, prompt) {
  const { directory, runtimeConfigPath, mcpServerPath } = fixture;
  // Inherit the authenticated client, but not another task's Fuli context token.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('FULI_')) delete env[key];
  const mcpArgs = [mcpServerPath, '--runtime-config', runtimeConfigPath, '--source-application', application];
  let args, command;
  if (application === 'codex') {
    command = process.env.FULI_HANDOFF_CODEX_BIN || 'codex';
    args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--color', 'never', '--json', '-C', directory,
      '-c', `mcp_servers.fuli.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.fuli.args=${JSON.stringify(mcpArgs)}`,
      '-c', 'mcp_servers.fuli.required=true',
      '-c', 'mcp_servers.fuli.tool_timeout_sec=120',
      '-c', 'mcp_servers.fuli.default_tools_approval_mode="auto"', prompt];
  } else {
    command = process.env.FULI_HANDOFF_CLAUDE_BIN || 'claude';
    const configPath = join(directory, 'claude-mcp.private.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: { fuli: { command: process.execPath, args: mcpArgs } } }), { mode: 0o600 });
    const settingsPath = join(directory, 'claude-settings.private.json');
    let authEnvironment = {};
    if (process.env.FULI_HANDOFF_CLAUDE_SETTINGS) {
      const settings = JSON.parse(await readFile(process.env.FULI_HANDOFF_CLAUDE_SETTINGS, 'utf8'));
      authEnvironment = Object.fromEntries(Object.entries(settings.env ?? {})
        .filter(([key]) => key.startsWith('ANTHROPIC_') || key === 'CLAUDE_CODE_OAUTH_TOKEN'));
    }
    // Only explicitly selected auth/model environment is copied. User hooks,
    // plugins and other MCP servers cannot touch the production Fuli database.
    await writeFile(settingsPath, JSON.stringify({ env: authEnvironment, disableAllHooks: true }), { mode: 0o600 });
    args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--max-budget-usd', '1.00', '--permission-mode', 'dontAsk', '--no-chrome', '--disable-slash-commands',
      '--setting-sources', '', '--settings', settingsPath, '--mcp-config', configPath, '--strict-mcp-config', '--tools', '',
      '--allowedTools', ['get_collaboration_preferences', 'get_project_agent_memory', 'checkpoint_project_agent_memory'].map(name => `mcp__fuli__${name}`).join(',')];
  }
  console.log(`Running real ${application} session...`);
  return clientEvidence(application, await run(command, args, { cwd: directory, env }));
}
