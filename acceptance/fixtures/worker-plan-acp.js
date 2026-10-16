// Synthetic ACP peer for disposable CLI acceptance. No model or login occurs.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mode = JSON.parse(await readFile(join(process.cwd(), 'synthetic-mode.json'), 'utf8'));
const observed = { pid: process.pid, sessionId: mode.sessionId, promptStarted: false, cancelled: false };
const save = () => writeFile(join(process.cwd(), 'synthetic-observed.json'), JSON.stringify(observed));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
let model = 'synthetic-model', effort = 'high', mcp, client, promptId;
const config = () => [{ id: 'model', name: 'Model', type: 'select', currentValue: model,
  options: [{ value: 'synthetic-model', name: 'Synthetic' }] },
{ id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: effort,
  options: ['high', 'max'].map(value => ({ value, name: value })) }];
const input = createInterface({ input: process.stdin });
input.on('line', line => { void handle(JSON.parse(line)).catch(() => process.exit(1)); });
input.on('close', () => { void client?.close().finally(() => process.exit(0)); });
async function handle(value) {
  if (value.method === 'initialize') {
    reply(value.id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'synthetic', version: '1' } });
    send({ jsonrpc: '2.0', method: '_auth/status_update', params: { authStatus: { kind: 'account', account: {} } } });
  } else if (value.method === 'session/new') {
    mcp = value.params.mcpServers[0];
    observed.runId = JSON.parse(mcp.env.find(item => item.name === 'FULI_WORKER_DESCRIPTOR').value).runId;
    await save();
    reply(value.id, { sessionId: mode.sessionId, configOptions: config() });
  } else if (value.method === 'session/set_config_option') {
    if (value.params.configId === 'model') model = value.params.value;
    else effort = value.params.value;
    reply(value.id, { configOptions: config() });
  } else if (value.method === 'session/prompt') {
    promptId = value.id; observed.promptStarted = true; await save();
    if (mode.hang) return;
    client = new Client({ name: 'synthetic-worker-plan-cli', version: '1' });
    const env = { ...process.env, ...Object.fromEntries(mcp.env.map(item => [item.name, item.value])) };
    const transport = new StdioClientTransport({ command: mcp.command, args: mcp.args, env, stderr: 'pipe' });
    transport.stderr?.resume();
    await client.connect(transport);
    const entry = await client.callTool({ name: 'get_collaboration_preferences', arguments: { projectPath: process.cwd() } });
    if (entry.isError) throw new Error('Synthetic entry failed');
    const checkpoint = await client.callTool({ name: 'checkpoint_task_knowledge', arguments: {
      taskContextToken: entry.structuredContent.taskContextToken, disposition: 'retain_nothing',
      reason: 'Disposable synthetic CLI acceptance.',
      workLog: { status: 'completed', summary: 'Synthetic ACP adapter exercised the actual CLI and Provider lifecycle.' }
    } });
    if (checkpoint.isError) throw new Error('Synthetic checkpoint failed');
    await client.close(); client = null;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: mode.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Synthetic result only.' } } } });
    reply(value.id, { stopReason: 'end_turn' });
  } else if (value.method === 'session/cancel') {
    observed.cancelled = true; await save();
    if (promptId) reply(promptId, { stopReason: 'cancelled' });
  }
}
