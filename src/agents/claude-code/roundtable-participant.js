import { runParticipantProcess, parseParticipantEvents } from '../../roundtables/process.js';

export function createClaudeCodeParticipant({ command = process.env.FULI_CLAUDE_BIN ?? 'claude',
  workspace = process.cwd(), env = process.env, model, runProcess = runParticipantProcess } = {}) {
  const settings = JSON.stringify({ disableAllHooks: true });
  const clientEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FULI_')));
  return {
    async preflight({ signal } = {}) {
      try {
        const result = await runProcess(command, ['--version'], { cwd: workspace, env: clientEnv, signal, timeoutMs: 10_000 });
        return { ready: result.code === 0, authentication: 'checked_on_dispatch', reason: result.code === 0 ? null : 'runtime_unavailable' };
      } catch (error) { return { ready: false, reason: error.code ?? 'runtime_unavailable' }; }
    },
    async dispatch({ prompt, signal, allowWrite = false, resultSchema }) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
        '--permission-mode', allowWrite ? 'acceptEdits' : 'dontAsk', '--no-chrome', '--disable-slash-commands',
        '--setting-sources', '', '--settings', settings, '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
        '--tools', allowWrite ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
        '--max-budget-usd', env.FULI_CLAUDE_MAX_BUDGET_USD ?? '1.00', ...(model ? ['--model', model] : []),
        ...(resultSchema ? ['--json-schema', JSON.stringify(resultSchema)] : [])];
      return parseParticipantEvents('claude_code', await runProcess(command, args, { cwd: workspace, env: clientEnv, input: prompt, signal }));
    }
  };
}
