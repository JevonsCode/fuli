import { modelFailure } from '../failures.js';
import { reportedUsage } from '../usage.js';
import { attemptFailure } from './exchange.js';

// A model from FULI's catalog that the graph service runs on this computer
// (src/embedding-models, graph-provider/fuli_graph/builtin_embedding.py). It
// serves only the semantic role and sends nothing out (`local`), so no
// project approval, key or price applies. The connection's model is the
// catalog id; the texts go to the graph service through the port's
// builtinEmbed, never to an address.

const DEFINITION = 'builtin_embeddings';

export const builtinEmbeddingsAdapter = Object.freeze({
  protocol: 'builtin_embeddings',
  outputMode: 'embedding',
  repairable: false,
  local: true,
  supports: () => false,
  async embed({ connection, texts, signal, builtinEmbed }) {
    const state = { actualModel: null, usage: reportedUsage({ definition: DEFINITION }) };
    if (!builtinEmbed) return attemptFailure(modelFailure('configuration', 'builtin_unavailable'), state);
    let answer;
    try {
      // The saved name is `id@revision` (src/embedding-models/port.js). The graph service runs the id
      // and refuses when the files on disk are another revision, so vectors of two sets of weights never share a name.
      const [model, version = ''] = connection.model.split('@');
      answer = await builtinEmbed({ model, revision: version.split('.')[0] || null, texts, signal });
    } catch (error) {
      // 404: the model is not downloaded (or was removed); 422: its files are not ones this version runs.
      if (error?.status === 404) return attemptFailure(modelFailure('configuration', 'model_not_downloaded'), state);
      if (error?.status === 422) return attemptFailure(modelFailure('configuration', 'model_not_runnable'), state);
      return attemptFailure(modelFailure('transient', signal?.aborted ? 'timeout' : 'graph_service_unavailable'), state);
    }
    const vectors = answer?.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.length
      || vectors.some(vector => !Array.isArray(vector) || vector.length !== vectors[0].length || !vector.every(Number.isFinite))) {
      return attemptFailure(modelFailure('configuration', 'invalid_response'), state);
    }
    state.actualModel = connection.model;
    state.usage = reportedUsage({ inputTokens: answer.tokens, outputTokens: 0, definition: DEFINITION });
    return { ok: true, vectors, dimensions: vectors[0].length, usage: state.usage, actualModel: state.actualModel };
  }
});
