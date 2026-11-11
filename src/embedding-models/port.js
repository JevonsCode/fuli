import { ApplicationError } from '../app/application-error.js';
import {
  BUILTIN_EMBEDDING_ENDPOINT, BUILTIN_EMBEDDING_PROTOCOL, KNOWLEDGE_EMBEDDING_OPERATION, SEMANTIC_ROLE
} from '../model-backends/config.js';
import { embeddingModelBytes } from './manifest.js';

// Built-in embedding models as the console and Agents use them: what the
// catalog offers, what is on this computer, which one search uses; download
// one, use one, remove one. A model runs in the graph service on this
// computer, so using it needs no key and sends nothing out.
//
// registry: the catalog (registry.js). store: the files (store.js).
// modelBackends: the model port, read for which model search uses.
// roleSettings: saves the semantic role (model-backends/role-settings.js).
// unload(): the graph service lets go of the loaded model's files.
// fillIndex(): starts filling the meaning index now.

// The one connection a built-in model is saved as.
const CONNECTION_ID = 'builtin-embedding';
// The files' revision is part of the saved model name (`id@revision`), so new
// weights under the same id are another model to the meaning index and to the
// query cache: both rebuild instead of mixing vectors of two sets of weights.
const REVISION_CHARS = 12;
const savedModel = (id, revision) => (revision ? `${id}@${String(revision).slice(0, REVISION_CHARS)}` : id);
export const builtinModelId = model => String(model).split('@')[0];

export function createEmbeddingModels({ registry, store, modelBackends, roleSettings, unload = async () => {},
  fillIndex = () => {} }) {
  const catalog = () => registry.current().manifest;

  function entry(id) {
    const model = catalog().models.find(item => item.id === id);
    if (!model) throw new ApplicationError('embedding_model_unknown', 'This model is not in the catalog.', { status: 404 });
    return model;
  }

  // The built-in model search uses now, or null (none, or the person's own model service).
  function inUse() {
    const semantic = modelBackends.roles().roles.find(item => item.role === SEMANTIC_ROLE);
    return semantic?.state === 'enabled' && semantic.connection.protocol === BUILTIN_EMBEDDING_PROTOCOL
      ? builtinModelId(semantic.connection.model) : null;
  }

  function list() {
    const current = registry.current();
    const installed = new Map(store.installed().map(item => [item.id, item]));
    const used = inUse();
    return {
      catalog: { manifestVersion: current.manifest.manifestVersion, updatedAt: current.manifest.updatedAt,
        autoUpdate: current.autoUpdate, lastCheckedAt: current.lastCheckedAt },
      inUse: used,
      models: current.manifest.models.map(model => ({
        id: model.id, name: model.name, summary: model.summary, languages: model.languages, license: model.license,
        source: model.source, dimensions: model.dimensions, memoryMb: model.memoryMb, recommended: model.recommended,
        downloadBytes: embeddingModelBytes(model),
        // A catalog update may name a newer revision of a model already here.
        installed: installed.has(model.id), outdated: installed.has(model.id) && installed.get(model.id).revision !== model.revision,
        inUse: used === model.id, download: store.progress(model.id)
      })),
      // On this computer but no longer in the catalog: still usable, and removable.
      retired: [...installed.keys()].filter(id => !current.manifest.models.some(model => model.id === id))
    };
  }

  // Search uses this model from now on; the index fills for it in the background.
  function use(id) {
    const installed = store.installed().find(item => item.id === id);
    if (!installed) {
      throw new ApplicationError('embedding_model_not_downloaded', 'Download this model first.', { status: 409 });
    }
    const saved = roleSettings.save(SEMANTIC_ROLE, {
      revision: modelBackends.roles().revision,
      connectionId: CONNECTION_ID,
      connection: { protocol: BUILTIN_EMBEDDING_PROTOCOL, endpoint: BUILTIN_EMBEDDING_ENDPOINT,
        model: savedModel(id, installed.revision) },
      settings: { enabled: true, allowedOperations: [KNOWLEDGE_EMBEDDING_OPERATION], budget: {} }
    });
    fillIndex();
    return { ...list(), history: saved.history };
  }

  // Starts the download and answers at once ({ started, done }); `list()` shows how far it is.
  // With useAfter, search switches to the model when the download is whole.
  function download(id, { useAfter = false } = {}) {
    const model = entry(id);
    const done = (async () => {
      // A copy being replaced must not be held open by the graph service.
      await store.download(model, { beforeReplace: () => unload().catch(() => {}) });
      // New files for the model search already uses are saved as its new revision, so the index rebuilds.
      if (useAfter || inUse() === id) use(id);
    })();
    // The outcome is read from list(): a failed download shows there with its reason.
    done.catch(() => {});
    return { started: id, done };
  }

  function refuseInUse(id) {
    if (inUse() !== id) return;
    throw new ApplicationError('embedding_model_in_use', 'Search uses this model. Switch to another model or turn search by meaning off first.',
      { status: 409 });
  }

  async function remove(id) {
    refuseInUse(id);
    await unload().catch(() => {});
    // Search may have switched to this model while the graph service let go of it:
    // checked again here, with nothing awaited before the files go.
    refuseInUse(id);
    store.remove(id);
    return list();
  }

  return { list, download, use, remove };
}
