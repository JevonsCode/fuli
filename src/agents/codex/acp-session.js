import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { parse } from 'smol-toml';
import { methods } from '@agentclientprotocol/sdk';
import { ApplicationError } from '../../app/application-error.js';

const failure = code => new ApplicationError(`acp_${code}`, `Codex ACP ${code.replaceAll('_', ' ')}.`);
const samePath = (a, b) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const ignoredUpdates = new Set(['user_message_chunk', 'agent_thought_chunk', 'plan', 'plan_update',
  'plan_removed', 'available_commands_update', 'current_mode_update', 'session_info_update',
  'usage_update', 'notice', 'compaction_update', 'compaction_summary_chunk']);

// One new session, an acknowledged model configuration, and one prompt attempt.
// Configuration ACKs and tool status notifications are not evidence of actual model execution.
export function createCodexAcpSession({ cwd, codexHome, request, notify, close, signal }) {
  let sessionId = null, opening = false, attempted = false, observedSessionId = null;
  let configuring = false, configuration = null, options = [], promptStarted = false, prompting = false, cancelling;
  let output = '', toolUpdates = [], toolUpdatesTruncated = false;
  const ensureOpen = () => {
    if (signal.aborted) throw signal.reason ?? failure('closed');
    if (cancelling) throw failure('cancelled');
  };
  const api = {
    async newSession(input = {}) {
      keys(input, ['mcpServers', 'timeoutMs'], 'invalid_session');
      ensureOpen();
      if (opening || attempted) throw failure('session_already_created');
      const mcpServers = stdioServers(input.mcpServers ?? []);
      opening = true;
      try {
        await requireTrustedCwd(codexHome, cwd);
        ensureOpen();
        attempted = true;
        const response = await exchange(methods.agent.session.new, { cwd, mcpServers }, input);
        if (!text(response.sessionId, 128) || (observedSessionId && observedSessionId !== response.sessionId)) {
          await close(failure('protocol_error')); throw failure('protocol_error');
        }
        sessionId = response.sessionId;
        options = response.configOptions ?? [];
        return { sessionId, configOptions: structuredClone(options) };
      } finally { opening = false; }
    },
    async configureModel(input) {
      keys(input, ['modelId', 'reasoningEffort', 'timeoutMs'], 'invalid_model');
      ensureOpen();
      if (!sessionId || configuring || promptStarted || configuration) throw failure('invalid_model_state');
      if (!text(input.modelId, 256) || !text(input.reasoningEffort, 128)) throw failure('invalid_model');
      if (!select(options, 'model').values.includes(input.modelId)) throw failure('model_unavailable');
      configuring = true;
      try {
        let response = await exchange(methods.agent.session.setConfigOption,
          { sessionId, configId: 'model', value: input.modelId }, input);
        options = response.configOptions;
        if (select(options, 'model').current !== input.modelId) throw failure('model_mismatch');
        if (!select(options, 'reasoning_effort').values.includes(input.reasoningEffort)) throw failure('model_unavailable');
        response = await exchange(methods.agent.session.setConfigOption,
          { sessionId, configId: 'reasoning_effort', value: input.reasoningEffort }, input);
        options = response.configOptions;
        if (select(options, 'model').current !== input.modelId ||
            select(options, 'reasoning_effort').current !== input.reasoningEffort) throw failure('model_mismatch');
        configuration = { modelId: input.modelId, reasoningEffort: input.reasoningEffort };
        return { ...configuration };
      } catch (error) { await close(error); throw error; }
      finally { configuring = false; }
    },
    async promptOnce(input) {
      keys(input, ['text', 'signal', 'timeoutMs'], 'invalid_prompt');
      ensureOpen();
      if (promptStarted) throw failure('prompt_already_started');
      if (!sessionId || !configuration || configuring) throw failure('model_not_configured');
      if (!text(input.text, 64 * 1024) || Buffer.byteLength(input.text) > 64 * 1024) throw failure('invalid_prompt');
      promptStarted = true; prompting = true;
      try {
        const response = await exchange(methods.agent.session.prompt,
          { sessionId, prompt: [{ type: 'text', text: input.text }] },
          { timeoutMs: input.timeoutMs ?? 300_000, signal: input.signal }, 600_000);
        return { sessionId, configuration: { ...configuration }, text: output, stopReason: response.stopReason,
          toolUpdates: structuredClone(toolUpdates), toolUpdatesTruncated };
      } finally { prompting = false; }
    },
    cancel() {
      cancelling ??= Promise.resolve().then(async () => {
        if (prompting && !signal.aborted) {
          void notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
        }
        await close(failure('cancelled'));
      });
      return cancelling;
    }
  };
  async function exchange(method, params, { timeoutMs = 15_000, signal: callerSignal } = {}, maximum = 60_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) throw failure('invalid_timeout');
    ensureOpen();
    if (callerSignal?.aborted) { await api.cancel(); throw failure('cancelled'); }
    const abort = () => { void api.cancel().catch(() => {}); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void close(failure('timeout')).catch(() => {}); }, timeoutMs);
    callerSignal?.addEventListener('abort', abort, { once: true });
    if (callerSignal?.aborted) abort();
    try {
      ensureOpen();
      const response = await request(method, params);
      ensureOpen();
      return response;
    } catch {
      // Cleanup can outlive the prompt timer; preserve the first terminal reason.
      const error = signal.reason ?? (timedOut ? failure('timeout') : failure('request_failed'));
      await close(error); throw error;
    } finally { clearTimeout(timer); callerSignal?.removeEventListener('abort', abort); }
  }
  // Called before the SDK, so malformed notifications never enter its raw-error logger.
  function projectUpdate(params) {
    if (!params || !text(params.sessionId, 128) || (!sessionId && !(opening && attempted)) ||
        (sessionId && params.sessionId !== sessionId) ||
        (observedSessionId && observedSessionId !== params.sessionId)) throw failure('protocol_error');
    observedSessionId = params.sessionId;
    const update = params.update;
    if (!update || typeof update !== 'object') throw failure('protocol_error');
    const kind = update.sessionUpdate;
    if (ignoredUpdates.has(kind)) return null;
    if (kind === 'agent_message_chunk') {
      if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw failure('protocol_error');
      if (!prompting) throw failure('protocol_error');
      if (Buffer.byteLength(output) + Buffer.byteLength(update.content.text) > 64 * 1024) throw failure('output_limit');
      output += update.content.text;
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      if (!text(update.toolCallId, 128) || (update.status !== undefined &&
          !['pending', 'in_progress', 'completed', 'failed'].includes(update.status))) throw failure('protocol_error');
      if (toolUpdates.length < 64) toolUpdates.push({ toolCallId: update.toolCallId,
        ...(update.status !== undefined ? { status: update.status } : {}) });
      else toolUpdatesTruncated = true;
    } else if (kind === 'config_option_update') {
      if (!Array.isArray(update.configOptions)) throw failure('protocol_error');
      if (configuration && (select(update.configOptions, 'model').current !== configuration.modelId ||
          select(update.configOptions, 'reasoning_effort').current !== configuration.reasoningEffort)) throw failure('model_mismatch');
    } else throw failure('protocol_error');
    return null; // Consumed by this bounded port; no raw tool input, thoughts, or private metadata leave it.
  }
  return { ...api, projectUpdate };
}

function keys(input, allowed, code) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some(key => !allowed.includes(key))) throw failure(code);
}
function stdioServers(input) {
  if (!Array.isArray(input) || input.length > 8 || Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw failure('invalid_session');
  const names = new Set();
  for (const item of input) {
    keys(item, ['name', 'command', 'args', 'env'], 'invalid_session');
    if (!text(item.name, 128) || !/^[A-Za-z0-9_-]+$/.test(item.name) || names.has(item.name) ||
        !text(item.command, 4096) || !isAbsolute(item.command) || !Array.isArray(item.args) ||
        item.args.some(value => typeof value !== 'string') || !Array.isArray(item.env)) throw failure('invalid_session');
    names.add(item.name);
    for (const variable of item.env) {
      keys(variable, ['name', 'value'], 'invalid_session');
      if (!text(variable.name, 256) || typeof variable.value !== 'string') throw failure('invalid_session');
    }
  }
  return structuredClone(input);
}
function select(options, id) {
  const matches = Array.isArray(options) ? options.filter(option => option?.id === id) : [];
  const option = matches[0];
  if (matches.length !== 1 || option.type !== 'select' || !Array.isArray(option.options)) throw failure('model_unavailable');
  const values = option.options.flatMap(item => typeof item.value === 'string' ? [item.value]
    : Array.isArray(item.options) ? item.options.map(value => value.value) : []);
  if (typeof option.currentValue !== 'string' || !values.includes(option.currentValue)) throw failure('model_unavailable');
  return { values, current: option.currentValue };
}
async function requireTrustedCwd(home, cwd) {
  // The official adapter overrides cwd trust internally. Require a pre-existing exact
  // native trust record first; never manufacture trust or inspect authentication files.
  try {
    const path = join(home, 'config.toml');
    if ((await stat(path)).size > 256 * 1024) throw failure('directory_untrusted');
    const content = await readFile(path, 'utf8');
    if (Buffer.byteLength(content) > 256 * 1024) throw failure('directory_untrusted');
    const projects = parse(content).projects ?? {};
    const matches = Object.entries(projects).filter(([path]) => isAbsolute(path) && samePath(path, cwd));
    if (!matches.length || matches.some(([, value]) => value?.trust_level !== 'trusted')) throw failure('directory_untrusted');
  } catch { throw failure('directory_untrusted'); }
}
