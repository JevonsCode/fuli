import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationError } from '../../app/application-error.js';
import { WORKER_DESCRIPTOR_ENV, validateWorkerDescriptor } from '../../graphiti/worker-descriptor.js';
import { startCodexAcpProcess } from './acp-process.js';

const failure = code => new ApplicationError(code, 'Codex ACP worker cannot start with this configuration.');
const errorCodes = {
  acp_directory_untrusted: 'worker_workspace_untrusted', acp_model_unavailable: 'worker_model_unavailable',
  acp_model_mismatch: 'worker_model_mismatch', acp_cancelled: 'worker_cancelled', acp_timeout: 'worker_timeout',
  acp_closed: 'worker_connection_closed', acp_cleanup_incomplete: 'worker_cleanup_incomplete'
};

async function call(operation) {
  try { return await operation(); }
  catch (error) {
    const code = Object.hasOwn(errorCodes, error?.code) ? errorCodes[error.code] : 'worker_transport_failed';
    const safe = failure(error?.cleanupIncomplete ? 'worker_cleanup_incomplete' : code);
    if (error?.cleanupIncomplete) safe.cleanupIncomplete = true;
    throw safe;
  }
}

// Codex-specific composition; the common host never branches on an Agent ID.
// Configuration acknowledgements do not establish actual provider/model use.
export function createCodexAcpWorkerAdapter({ adapterPath, codexPath, codexHome, runtimeConfigPath,
  startProcess = startCodexAcpProcess }) {
  if (typeof runtimeConfigPath !== 'string' || !isAbsolute(runtimeConfigPath)) throw failure('worker_invalid_attempt');
  return { application: 'codex', async start({ descriptor: input, selection, signal }) {
    const descriptor = validateWorkerDescriptor(input);
    const modelId = selection.model;
    const reasoningEffort = selection.model_strategy?.reasoning_effort;
    if (selection.target_application !== 'codex' || typeof selection.model !== 'string' ||
        !['low', 'medium', 'high', 'max'].includes(reasoningEffort)) throw failure('worker_model_strategy_unmapped');
    const handle = await call(() => startProcess({ adapterPath, codexPath, codexHome, cwd: descriptor.projectPath, signal }));
    try {
      if (!['account', 'api_key', 'gateway', 'external'].includes(handle.authentication)) {
        throw failure('worker_authentication_required');
      }
      return {
        newSession: () => call(() => handle.newSession({ mcpServers: [{ name: 'fuli_worker', command: process.execPath,
          args: [fileURLToPath(new URL('../../mcp-server.js', import.meta.url)), '--worker', '--runtime-config', runtimeConfigPath],
          env: [{ name: WORKER_DESCRIPTOR_ENV, value: JSON.stringify(descriptor) }] }] })),
        configure: () => call(() => handle.configureModel({ modelId, reasoningEffort })),
        promptOnce: input => call(() => handle.promptOnce(input)), close: () => call(() => handle.close())
      };
    } catch (error) { await call(() => handle.close()); throw error; }
  } };
}
