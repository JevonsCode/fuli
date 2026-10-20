import { httpFailure, modelFailure } from '../failures.js';
import { reportedUsage, tokenCount } from '../usage.js';
import {
  MAX_REPLY_CHARS, attemptFailure, errorDetails, postJson, readFailure, retryAfterMs, serverSentEvents
} from './exchange.js';

// Anthropic Messages API, streamed. Input usage arrives in message_start and
// cumulative output usage in message_delta, so the last value wins and is
// never summed. Anthropic reports input without cache reads and writes; the
// normalized input adds them back and keeps both as subsets.

const DEFINITION = 'anthropic_messages';
const API_VERSION = '2023-06-01';
const STREAM_ERRORS = Object.freeze({
  overloaded_error: ['transient', 'server_error'],
  api_error: ['transient', 'server_error'],
  rate_limit_error: ['transient', 'rate_limited'],
  timeout_error: ['transient', 'timeout'],
  authentication_error: ['configuration', 'auth_failed'],
  permission_error: ['refusal', 'permission_denied'],
  not_found_error: ['configuration', 'model_or_endpoint_not_found'],
  request_too_large: ['configuration', 'request_too_large'],
  billing_error: ['configuration', 'provider_billing']
});

export const anthropicMessagesAdapter = Object.freeze({
  protocol: 'anthropic_messages',
  outputMode: 'json_schema',
  repairable: true,
  supports: () => true,
  async call({ connection, secret, prompt, mode, maxOutputTokens, signal, fetchImpl }) {
    const counts = { input: null, cacheRead: null, cacheWrite: null, output: null };
    const state = { text: '', stop: null, actualModel: null };
    const progress = () => ({ actualModel: state.actualModel, usage: usageOf(counts) });
    const sent = await postJson({ fetchImpl, signal, url: `${connection.endpoint}/messages`,
      headers: { 'x-api-key': secret, 'anthropic-version': API_VERSION },
      body: {
        model: connection.model,
        max_tokens: maxOutputTokens,
        system: prompt.system,
        messages: prompt.turns.map(turn => ({ role: turn.role, content: turn.text })),
        stream: true,
        ...(mode === 'json_schema' ? { output_config: { format: { type: 'json_schema', schema: prompt.schema } } } : {})
      } });
    if (sent.failure) return attemptFailure(sent.failure, progress());
    const { response } = sent;
    if (!response.ok) {
      return attemptFailure(httpFailure(response.status, await errorDetails(response),
        { retryAfterMs: retryAfterMs(response.headers), structuredOutput: mode === 'json_schema' }), progress());
    }
    try {
      for await (const { data } of serverSentEvents(response)) {
        const event = JSON.parse(data);
        if (event.type === 'error') {
          const [failureClass, reason] = STREAM_ERRORS[event.error?.type] ?? ['transient', 'server_error'];
          return attemptFailure(modelFailure(failureClass, reason), progress());
        }
        if (event.type === 'message_start') {
          if (typeof event.message?.model === 'string') state.actualModel = event.message.model;
          absorbUsage(counts, event.message?.usage, { withOutput: false });
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') state.text += event.delta.text ?? '';
        if (event.type === 'message_delta') {
          state.stop = event.delta?.stop_reason ?? state.stop;
          absorbUsage(counts, event.usage, { withOutput: true });
        }
        if (state.text.length > MAX_REPLY_CHARS) return attemptFailure(modelFailure('configuration', 'output_truncated'), progress());
      }
    } catch (error) {
      return attemptFailure(readFailure(error), progress());
    }
    if (state.stop === 'refusal') return attemptFailure(modelFailure('refusal', 'model_refusal'), progress());
    if (state.stop === 'max_tokens') return attemptFailure(modelFailure('configuration', 'output_truncated'), progress());
    return { ok: true, reply: state.text, ...progress() };
  }
});

// message_start carries a placeholder output count; only message_delta
// reports output, so an interrupted stream leaves output unknown.
function absorbUsage(counts, usage, { withOutput }) {
  if (!usage) return;
  for (const [name, field] of [['input', 'input_tokens'], ['cacheRead', 'cache_read_input_tokens'], ['cacheWrite', 'cache_creation_input_tokens']]) {
    counts[name] = tokenCount(usage[field]) ?? counts[name];
  }
  if (withOutput) counts.output = tokenCount(usage.output_tokens) ?? counts.output;
}

function usageOf(counts) {
  return reportedUsage({
    inputTokens: counts.input === null ? null : counts.input + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0),
    outputTokens: counts.output, cachedInputTokens: counts.cacheRead, cacheWriteInputTokens: counts.cacheWrite,
    definition: DEFINITION
  });
}
