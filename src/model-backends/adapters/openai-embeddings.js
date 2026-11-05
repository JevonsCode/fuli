import { httpFailure, modelFailure } from '../failures.js';
import { reportedUsage } from '../usage.js';
import { attemptFailure, errorDetails, postJson, readFailure, readJsonBody, retryAfterMs } from './exchange.js';

// OpenAI-compatible embeddings: POST {endpoint}/embeddings with
// { model, input: [...] }, as OpenAI, Ollama (/v1) and DashScope's compatible
// mode answer it. It serves only the semantic role (config.js), so it takes
// no decision request. A reply is used whole or not at all: one vector per
// text, in order, every one of the same length and made of finite numbers.
// Embeddings produce no output tokens, so a reported input is the whole usage.

const DEFINITION = 'openai_embeddings';
// 64 texts of a few thousand numbers each, written as decimal JSON.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export const openAiEmbeddingsAdapter = Object.freeze({
  protocol: 'openai_embeddings',
  outputMode: 'embedding',
  repairable: false,
  supports: () => false,
  async embed({ connection, secret, texts, signal, fetchImpl }) {
    const state = { actualModel: null, usage: reportedUsage({ definition: DEFINITION }) };
    const sent = await postJson({ fetchImpl, signal, url: `${connection.endpoint}/embeddings`,
      headers: { ...connection.headers, ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: { model: connection.model, input: texts } });
    if (sent.failure) return attemptFailure(sent.failure, state);
    const { response } = sent;
    if (!response.ok) {
      return attemptFailure(httpFailure(response.status, await errorDetails(response), { retryAfterMs: retryAfterMs(response.headers) }), state);
    }
    let body;
    try {
      body = await readJsonBody(response, { maxBytes: MAX_RESPONSE_BYTES });
    } catch (error) {
      return attemptFailure(readFailure(error), state);
    }
    if (typeof body?.model === 'string') state.actualModel = body.model;
    const inputTokens = body?.usage?.prompt_tokens ?? body?.usage?.total_tokens;
    if (inputTokens !== undefined) state.usage = reportedUsage({ inputTokens, outputTokens: 0, definition: DEFINITION });
    const vectors = orderedVectors(body?.data, texts.length);
    if (!vectors) return attemptFailure(modelFailure('configuration', 'invalid_response'), state);
    return { ok: true, vectors, dimensions: vectors[0].length, usage: state.usage, actualModel: state.actualModel };
  }
});

// The vectors in the order of the texts, or null when the reply is not one
// whole, consistent answer.
function orderedVectors(data, count) {
  if (!Array.isArray(data) || data.length !== count) return null;
  const vectors = new Array(count);
  for (const [position, item] of data.entries()) {
    const index = item?.index ?? position;
    if (!Number.isInteger(index) || index < 0 || index >= count || vectors[index]) return null;
    const vector = item?.embedding;
    if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) return null;
    vectors[index] = vector;
  }
  const dimensions = vectors[0].length;
  return vectors.every(vector => vector.length === dimensions) ? vectors : null;
}
