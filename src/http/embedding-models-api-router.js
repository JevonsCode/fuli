import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// Built-in embedding models on the console (src/embedding-models/port.js):
// GET lists the catalog with what is on this computer; POST downloads one
// (answering at once, the list shows progress), makes search use one, or
// removes one. Changes happen only on this computer.
const BASE = '/api/embedding-models';

export async function handleEmbeddingModelsRequest({ request, response, url, embeddingModels }) {
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (!embeddingModels) {
    sendJson(response, 503, { error: 'Built-in models need a local FULI installation', code: 'embedding_models_unavailable' });
    return true;
  }
  const route = `${request.method} ${url.pathname}`;
  if (route === `GET ${BASE}`) {
    sendJson(response, 200, embeddingModels.list());
    return true;
  }
  const action = ['download', 'use', 'remove'].find(name => route === `POST ${BASE}/${name}`);
  if (!action) return false;
  if (refuseRemoteDecision(request, response, 'Built-in models change only on this computer')) return true;
  const input = await readJson(request);
  if (typeof input?.id !== 'string') throw new TypeError('id of the model is required');
  if (action === 'download') {
    embeddingModels.download(input.id, { useAfter: input.use === true });
    sendJson(response, 202, embeddingModels.list());
  } else if (action === 'use') {
    sendJson(response, 200, embeddingModels.use(input.id));
  } else {
    sendJson(response, 200, await embeddingModels.remove(input.id));
  }
  return true;
}
