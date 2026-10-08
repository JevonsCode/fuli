import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withIsolatedRuntime } from './runtime.js';
import { publicClientEvidence, runClient } from './clients.js';
import { run } from './process.js';

// Opt-in: real authenticated clients incur normal account usage. The fixture and
// database are synthetic; no production memory, settings or MCP config is changed.
const report = { startedAt: new Date().toISOString(), fixture: 'synthetic',
  evidence: 'real CLI clients + MCP + disposable Provider/Neo4j',
  boundaries: ['Explicit memory API calls; native entry/Stop hooks are not tested.',
    'No worker orchestration or completion-table claim is inferred from these CLI calls.'],
  checks: [], clients: [] };
const output = resolve(process.env.FULI_HANDOFF_OUTPUT || 'test-artifacts/handoff-live.json');
const check = (name, condition) => { report.checks.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); };
function requireTool(client, name) {
  check(`${client.application}: ${name} succeeded`, client.tools.some(tool => tool.name.endsWith(name) && tool.succeeded));
}

try {
  for (const [client, command] of [['codex', process.env.FULI_HANDOFF_CODEX_BIN || 'codex'],
    ['claude_code', process.env.FULI_HANDOFF_CLAUDE_BIN || 'claude']]) {
    const result = await run(command, ['--version'], { timeoutMs: 15_000 });
    assert.equal(result.code, 0, `${client} is installed`);
    report[`${client}Version`] = result.stdout.trim();
  }
  await withIsolatedRuntime(async fixture => {
    const { api, spaceId } = fixture;
    const projectId = 'handoff-alpha', siblingId = 'handoff-beta', agentId = 'handoff-engineer';
    for (const project of [projectId, siblingId]) {
      await api('/v1/personal-projects', { personal_space_id: spaceId, project_id: project,
        profile: { name: project, lifecycle: 'active' } }, 'PUT');
      await api('/v1/project-agents', { personal_space_id: spaceId, personal_project_id: project, agent_id: agentId,
        profile: { name: 'Synthetic handoff engineer', responsibility: 'Remember the synthetic acceptance brief.',
          allowed_clients: ['codex', 'claude_code'], capabilities: ['coding'], work_kinds: ['implementation'] } }, 'PUT');
    }
    const memory = project => api(`/v1/project-agents/${agentId}/memory?${new URLSearchParams({
      personal_space_id: spaceId, personal_project_id: project, limit: '10' })}`);
    const marker = `ASTER-${randomBytes(5).toString('hex')}`;
    const initial = `Synthetic service ${marker}: restart verification is pending.`;
    const corrected = `Synthetic service ${marker}: restart verification passed.`;
    const identifiers = `personalSpaceId=${spaceId}; personalProjectId=${projectId}; agentId=${agentId}.`;
    const constraints = `This is an authorized synthetic acceptance in a disposable database. Use only the Fuli MCP tools listed below. Do not read files, run commands, delegate, search the web, or create any task or project. First call get_collaboration_preferences with projectPath=${JSON.stringify(fixture.directory)} and taskPrompt="Synthetic handoff acceptance". Then follow the exact calls below. Use camelCase inputs. Return a short factual summary; no table. The caller will verify every database write.`;
    const codex = await runClient('codex', fixture, `${constraints}\n${identifiers}
Call get_project_agent_memory for those exact IDs. It must be revision 0. Then call checkpoint_project_agent_memory with expectedRevision=0, idempotencyKey="synthetic-codex-first-memory", memory={"summary":${JSON.stringify(initial)},"decisions":["Use the existing local graph."],"openThreads":["Verify restart."],"nextActions":["Run the restart check."]}. No taskId is needed. Confirm the written revision.`);
    report.clients.push(publicClientEvidence(codex));
    check('Codex client completed', codex.exitCode === 0 && !codex.error);
    requireTool(codex, 'get_project_agent_memory');
    requireTool(codex, 'checkpoint_project_agent_memory');
    const first = await memory(projectId);
    check('Codex wrote revision 1 through MCP', first.revision === 1 && first.current.memory.summary === initial && first.current.source_application === 'codex');

    // Deliberately do not pass either the random marker or original summary to Claude.
    const claude = await runClient('claude_code', fixture, `${constraints}\n${identifiers}
1. Call get_project_agent_memory for these IDs. In your final answer quote the exact recovered current summary and its revision.
2. Call get_project_agent_memory again with the same space and agent but personalProjectId=${siblingId}. Report whether this sibling project has any memory; do not write sibling memory.
3. Correct only the main project's remembered restart status: replace "restart verification is pending." with "restart verification passed." in its recovered summary. Preserve its decisions. Set openThreads=[] and nextActions=["Check another client recovery."]. Call checkpoint_project_agent_memory with its current expectedRevision and idempotencyKey="synthetic-claude-correct-memory". Confirm the resulting revision and original recovered summary in your final answer. Never invent a missing summary.`);
    report.clients.push(publicClientEvidence(claude));
    check('Claude Code client completed', claude.exitCode === 0 && !claude.error);
    requireTool(claude, 'get_project_agent_memory');
    requireTool(claude, 'checkpoint_project_agent_memory');
    check('Fresh Claude session recovered the undisclosed marker', claude.answer.includes(marker));
    const latest = await memory(projectId), sibling = await memory(siblingId);
    check('Current memory is corrected by Claude Code', latest.revision === 2 && latest.current.memory.summary === corrected && latest.current.source_application === 'claude_code');
    check('Original historical revision survives', latest.history.some(item => item.revision === 1 && item.memory.summary === initial));
    check('Sibling project stays empty', sibling.revision === 0 && !sibling.current);
    report.memory = { current: corrected, revisions: latest.history.map(item => ({ revision: item.revision, sourceApplication: item.source_application })), siblingRevision: sibling.revision };
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  // JSON parser errors can quote private settings or an upstream response.
  // Publish fixed codes only; the checks above identify the failed assertion.
  report.error = error.code === 'ERR_ASSERTION' ? 'acceptance_assertion_failed' : 'acceptance_failed';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, error: report.error, report: output }, null, 2));
}
