#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jsonLifecycleOutput, unavailableOutput } from './lifecycle.js';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--') || args.indexOf(name, index + 1) >= 0) throw new TypeError('Invalid hook option');
  return value;
}
let input = {};
let event;
let app;
let leases;
let emitted = false;
const controller = new AbortController();
function emit(value, done) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(value) + '\n', done);
}
const deadline = setTimeout(() => {
  controller.abort();
  emit(unavailableOutput(event, input), () => process.exit(0));
}, 28000);
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw new TypeError('Hook input exceeds limit');
    chunks.push(chunk);
  }
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  event = option('--event', input.hook_event_name);
  const clientId = option('--client-id');
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(clientId ?? '')) throw new TypeError('A stable client ID is required');
  const root = resolve(option('--runtime-root', join(import.meta.dirname, '../../..')));
  const load = file => import(pathToFileURL(join(root, 'src', file)));
  const [{ callAgentTool }, { openFederatedGraphApplication }, { createRuntimeLeaseClient },
    { resolveGraphRuntimeOptions }, { compactTaskContext }, { hookAdditionalContextToolResult }] = await Promise.all([
    load('agent-tools.js'), load('graphiti/federated-application.js'), load('adaptive-runtime/lease-client.js'),
    load('graphiti/runtime-config.js'), load('conversations/task-context-view.js'), load('mcp/tool-result.js')
  ]);
  const { runtimeConfigPath } = resolveGraphRuntimeOptions(args);
  const stateDir = join(dirname(runtimeConfigPath), 'client-hooks', clientId);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(JSON.stringify([input.session_id, input.run_id])).digest('hex');
  const statePath = join(stateDir, key + '.json');
  const readState = async () => { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const writeState = async value => {
    const temporary = statePath + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, statePath);
  };
  app = openFederatedGraphApplication({ runtimeConfigPath });
  leases = createRuntimeLeaseClient({ runtimeConfigPath });
  const request = { signal: controller.signal };
  const output = await leases.withGraphLease('json-client-lifecycle', () => jsonLifecycleOutput(event, input, {
    invoke: async (name, parameters) => {
      const result = await callAgentTool(app, name, parameters, request);
      if (name !== 'verify_task_checkpoint') return result;
      // A completed checkpoint must also belong to this run, not a newer one.
      const current = await app.taskContextRegistry.current(input.session_id, 'other');
      return { ...result, task_context_token: current?.token ?? 'unavailable' };
    }, readState, writeState,
    formatContext: value => JSON.parse(hookAdditionalContextToolResult(compactTaskContext(value), {
      hookEventName: event, label: 'FULI task context', limitBytes: 44 * 1024, itemLimit: 1000
    }).content[0].text).hookSpecificOutput.additionalContext
  }), request);
  emit(output);
} catch {
  emit(unavailableOutput(event, input));
} finally {
  await Promise.allSettled([leases?.close(), app?.close()]);
  clearTimeout(deadline);
}
