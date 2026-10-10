import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClientCommand, runProcess, parseFinalAnswer } from '../agent-roundtable/wake.js';
import { wakeAdapter } from '../agents/wake-registry.js';

// A bounded evaluation in an empty directory. Client adapters disable custom
// hooks/MCP/tools; supplied evidence is data, not instructions or permissions.
export async function runJudgment({ client, quality, prompt, env = process.env, run = runProcess }) {
  const command = resolveClientCommand(client, { env });
  if (!command) throw Object.assign(new Error('The selected judgment client is unavailable'), { code: 'client_unavailable' });
  const cwd = await mkdtemp(join(tmpdir(), 'fuli-judgment-'));
  try {
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FULI_') && key !== 'CLAUDECODE'));
    const result = await run(command, wakeAdapter(client).judgmentArgs({ cwd, quality }),
      { cwd, env: childEnv, input: prompt, timeoutMs: 90_000 });
    const answer = parseFinalAnswer(client, result);
    let model = null;
    for (const line of result.stdout.split(/\r?\n/)) {
      try { const event = JSON.parse(line); model = event.model ?? event.message?.model ?? model; } catch { /* not JSON */ }
    }
    return { ...answer, client, model: typeof model === 'string' ? model : null };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
