import { httpFailure, modelFailure } from '../failures.js';
import { reportedUsage } from '../usage.js';
import {
  MAX_REPLY_CHARS, attemptFailure, errorDetails, isJsonResponse, postJson, readFailure,
  readJsonBody, retryAfterMs, serverSentEvents
} from './exchange.js';

// OpenAI-compatible Chat Completions (OpenAI, Ollama, vLLM, LM Studio...).
// Streams with include_usage so usage arrives in the final chunk. Asks for
// json_schema output first; the port switches to prompt mode when the
// endpoint rejects it, and validates the reply strictly either way.

const DEFINITION = 'openai_chat';
const SCHEMA_NAME = 'fuli_decision';

export const openAiChatAdapter = Object.freeze({
  protocol: 'openai_chat',
  outputMode: 'json_schema',
  repairable: true,
  supports: () => true,
  async call({ connection, secret, prompt, mode, maxOutputTokens, signal, fetchImpl }) {
    const state = { text: '', refusal: '', finish: null, actualModel: null, usage: reportedUsage({ definition: DEFINITION }) };
    const sent = await postJson({ fetchImpl, signal, url: `${connection.endpoint}/chat/completions`,
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      body: {
        model: connection.model,
        messages: [{ role: 'system', content: prompt.system }, ...prompt.turns.map(turn => ({ role: turn.role, content: turn.text }))],
        max_tokens: maxOutputTokens,
        ...(connection.reasoningEffort ? { reasoning_effort: connection.reasoningEffort } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(mode === 'json_schema'
          ? { response_format: { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema: prompt.schema } } } : {})
      } });
    if (sent.failure) return attemptFailure(sent.failure, state);
    const { response } = sent;
    if (!response.ok) {
      return attemptFailure(httpFailure(response.status, await errorDetails(response),
        { retryAfterMs: retryAfterMs(response.headers), structuredOutput: mode === 'json_schema' }), state);
    }
    try {
      // A server that ignores `stream` answers with one JSON completion.
      if (isJsonResponse(response)) {
        const failure = absorb(state, await readJsonBody(response), 'message');
        if (failure) return attemptFailure(failure, state);
      } else {
        for await (const { data } of serverSentEvents(response)) {
          if (data === '[DONE]') break;
          const failure = absorb(state, JSON.parse(data), 'delta');
          if (failure) return attemptFailure(failure, state);
        }
      }
    } catch (error) {
      return attemptFailure(readFailure(error), state);
    }
    if (state.refusal) return attemptFailure(modelFailure('refusal', 'model_refusal'), state);
    if (state.finish === 'content_filter') return attemptFailure(modelFailure('refusal', 'content_policy'), state);
    if (state.finish === 'length') return attemptFailure(modelFailure('configuration', 'output_truncated'), state);
    return { ok: true, reply: state.text, usage: state.usage, actualModel: state.actualModel };
  }
});

function absorb(state, chunk, part) {
  if (chunk?.error) return modelFailure('transient', 'server_error');
  if (typeof chunk?.model === 'string') state.actualModel = chunk.model;
  if (chunk?.usage) {
    state.usage = reportedUsage({ inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens,
      cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
      reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens, definition: DEFINITION });
  }
  const choice = chunk?.choices?.[0];
  if (choice) {
    const content = choice[part] ?? {};
    if (typeof content.content === 'string') state.text += content.content;
    if (typeof content.refusal === 'string') state.refusal += content.refusal;
    state.finish = choice.finish_reason ?? state.finish;
  }
  return state.text.length > MAX_REPLY_CHARS ? modelFailure('configuration', 'output_truncated') : null;
}
