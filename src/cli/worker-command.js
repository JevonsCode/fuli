import { resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { workerRuntimeBindingKey } from '../graphiti/worker-plan-host.js';
import { createWorkerPlanRuntime } from '../server/worker-plan-runtime.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const invalid = () => new TypeError('Usage: fl worker dispatch --bindings FILE [--runtime-config FILE]; pipe {plan, idempotencyKey} on stdin');

export async function runWorkerCommand(args, { env = process.env, input = process.stdin,
  write = line => process.stdout.write(`${line}\n`), createRuntime = createWorkerPlanRuntime,
  signals = process } = {}) {
  const [action, ...flags] = args, values = new Map();
  if (action !== 'dispatch') throw invalid();
  for (let index = 0; index < flags.length; index += 2) {
    const [flag, value] = flags.slice(index, index + 2);
    if (!['--bindings', '--runtime-config'].includes(flag) || values.has(flag) ||
        typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw invalid();
    values.set(flag, value);
  }
  if (!values.has('--bindings')) throw invalid();
  const { runtimeConfigPath } = resolveGraphRuntimeOptions(values.has('--runtime-config')
    ? ['--runtime-config', values.get('--runtime-config')] : [], env);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signals.on('SIGINT', cancel);
  signals.on('SIGTERM', cancel);
  let runtime, result;
  try {
    const local = JSON.parse(await boundedFile(resolve(values.get('--bindings'))));
    if (local?.version !== 1 || Object.keys(local).some(key => !['version', 'bindings'].includes(key)) ||
        !Array.isArray(local.bindings) || local.bindings.length > 64) throw invalid();
    const bindings = new Map();
    for (const binding of local.bindings) {
      const key = workerRuntimeBindingKey(binding?.personalSpaceId, binding?.personalProjectId, binding?.executorId);
      if (bindings.has(key)) throw invalid();
      bindings.set(key, binding);
    }
    const request = JSON.parse(await boundedInput(input, controller.signal));
    if (!request || Object.keys(request).some(key => !['plan', 'idempotencyKey'].includes(key))) throw invalid();
    runtime = await createRuntime({ runtimeConfigPath, workerRuntimeBindings: bindings, env });
    result = await runtime.host.dispatch({ ...request, signal: controller.signal });
  } catch {
    result = { runId: null, outcome: { status: controller.signal.aborted ? 'cancelled' : 'failed',
      code: controller.signal.aborted ? 'worker_cancelled' : 'worker_dispatch_failed' } };
  } finally {
    signals.removeListener('SIGINT', cancel);
    signals.removeListener('SIGTERM', cancel);
    try { await runtime?.close(); }
    catch { result = { ...result, outcome: { status: 'failed', code: 'worker_cleanup_incomplete' } }; }
  }
  // No plan, transcript, checkpoint text, path, parent token or capability echo.
  const { runId, outcome, workerRuntime, reporting, cleanup } = result;
  const safe = { runId, outcome, ...(workerRuntime ? { workerRuntime } : {}),
    ...(reporting ? { reporting } : {}), ...(cleanup ? { cleanup } : {}) };
  write(JSON.stringify(safe));
  return { ...safe, exitCode: outcome.status === 'completed' ? 0 : outcome.status === 'blocked' ? 2
    : outcome.status === 'cancelled' ? 130 : 1 };
}

async function boundedFile(path) {
  // The stream bound also applies before JSON parsing.
  return boundedInput(createReadStream(path));
}
async function boundedInput(input, signal) {
  let bytes = 0;
  const chunks = [];
  const abort = () => input.destroy(new Error('Worker input cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw invalid();
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) throw invalid();
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal?.removeEventListener('abort', abort); }
}
