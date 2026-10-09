import { runParticipantProcess, parseParticipantEvents } from '../../roundtables/process.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexRoundtableConfig } from './roundtable-config.js';

export function createCodexParticipant({ command = process.env.FULI_CODEX_BIN ?? 'codex',
  workspace = process.cwd(), env = process.env, model, reasoningEffort = env.FULI_CODEX_REASONING_EFFORT,
  runProcess = runParticipantProcess } = {}) {
  if (reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new TypeError('Unsupported Codex reasoning effort');
  const clientEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FULI_')));
  return {
    async preflight({ signal } = {}) {
      try {
        const version = await runProcess(command, ['--version'], { cwd: workspace, env: clientEnv, signal, timeoutMs: 10_000 });
        const auth = await runProcess(command, ['login', 'status'], { cwd: workspace, env: clientEnv, signal, timeoutMs: 10_000 });
        return { ready: version.code === 0 && auth.code === 0, reason: auth.code === 0 ? null : 'waiting_auth', authentication: 'local_client_configuration' };
      } catch (error) { return { ready: false, reason: error.code ?? 'runtime_unavailable' }; }
    },
    async dispatch({ prompt, signal, allowWrite = false, resultSchema }) {
      const overrides = await prepareCodexRoundtableConfig({ command, workspace, env: clientEnv, signal, runProcess });
      const directory = resultSchema ? mkdtempSync(join(tmpdir(), 'fuli-roundtable-schema-')) : null;
      const schemaPath = directory ? join(directory, 'result.json') : null;
      if (schemaPath) writeFileSync(schemaPath, JSON.stringify(resultSchema), { mode: 0o600 });
      try {
      const args = ['exec', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', allowWrite ? 'workspace-write' : 'read-only', '--color', 'never', '--json', '-C', workspace,
        ...overrides, ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
        ...(model ? ['--model', model] : []), ...(schemaPath ? ['--output-schema', schemaPath] : []), '-'];
      return parseParticipantEvents('codex', await runProcess(command, args, { cwd: workspace, env: clientEnv, input: prompt, signal }));
      } finally { if (schemaPath) unlinkSync(schemaPath); if (directory) rmdirSync(directory); }
    }
  };
}
