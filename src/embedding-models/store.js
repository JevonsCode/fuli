import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ApplicationError } from '../app/application-error.js';
import { EMBEDDING_MODEL_ID, embeddingModelBytes } from './manifest.js';

// The embedding models on this computer: one folder per model under
// <data>/models/embedding, holding the three files the catalog names and
// `fuli-model.json`, written last. A folder without that file is not a model.
// A download keeps each file only when its size and SHA-256 are the catalog's;
// anything else is thrown away, so a cut or altered download never runs.

// What the graph service reads beside the files (graph-provider/fuli_graph/builtin_embedding.py).
export const MODEL_SPEC_FILE = 'fuli-model.json';
const PARTIAL_PREFIX = '.partial-';
// A download that sends nothing for this long is given up.
const IDLE_TIMEOUT_MS = 60_000;

export const embeddingModelsDirectory = dataDir => join(dataDir, 'models', 'embedding');

export function createEmbeddingModelStore({ directory, fetchImpl = globalThis.fetch, idleTimeoutMs = IDLE_TIMEOUT_MS,
  openFile = createWriteStream }) {
  // id -> { status: 'downloading' | 'failed', receivedBytes, totalBytes, reason }
  const downloads = new Map();

  function spec(id) {
    if (!EMBEDDING_MODEL_ID.test(id)) return null;
    try {
      return JSON.parse(readFileSync(join(directory, id, MODEL_SPEC_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  // The models that finished downloading: { id, revision, dimensions, bytes }.
  function installed() {
    let names = [];
    try { names = readdirSync(directory); } catch { return []; }
    return names.map(id => ({ id, spec: spec(id) })).filter(entry => entry.spec)
      .map(({ id, spec: found }) => ({ id, revision: found.revision ?? null, dimensions: found.dimensions ?? null, bytes: found.bytes ?? null }));
  }

  const progress = id => downloads.get(id) ?? null;

  async function fetchFile(file, target, state, signal) {
    let last = 'unavailable';
    for (const url of file.urls) {
      const before = state.receivedBytes;
      try {
        await fetchOne(url, file, target, state, signal);
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        state.receivedBytes = before;
        last = error?.code === 'embedding_model_altered' ? error.code : (error?.message ?? String(error));
        if (error?.code === 'embedding_model_altered') continue;
      }
    }
    throw new ApplicationError(last === 'embedding_model_altered' ? last : 'embedding_model_unavailable',
      last === 'embedding_model_altered'
        ? `${file.path} did not match the catalog's digest from any source, so it was not kept.`
        : `${file.path} could not be downloaded: ${last}`, { status: 502 });
  }

  // openFile(path) makes the file's write stream; a test can make it fail the way a full disk does.
  async function fetchOne(url, file, target, state, signal) {
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(new Error('the download stalled')), idleTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    try {
      // The model host answers with a redirect to its file store; the digest decides what is kept.
      const response = await fetchImpl(url, { redirect: 'follow', signal: combined });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const hash = createHash('sha256');
      let received = 0;
      const checked = async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > file.bytes) throw altered();
          hash.update(chunk);
          state.receivedBytes += chunk.length;
          clearTimeout(timer);
          timer = setTimeout(() => idle.abort(new Error('the download stalled')), idleTimeoutMs);
          yield chunk;
        }
      };
      // pipeline carries a read, check or write error to this await and closes the file either way:
      // a disk that fills up fails this download instead of raising an unhandled stream error.
      await pipeline(Readable.from(response.body), checked, openFile(target), { signal: combined });
      if (received !== file.bytes || hash.digest('hex') !== file.sha256) throw altered();
    } finally {
      clearTimeout(timer);
    }
  }

  // Throws away a partial download. Windows may still hold a file that just failed to write, so it
  // is tried a few times, and a folder that will not go is left for the next download to clear:
  // the failure that brought us here is the one the person hears about.
  function discard(folder) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch { /* The next download of this model removes it first. */ }
  }

  const altered = () => Object.assign(new Error('digest mismatch'), { code: 'embedding_model_altered' });

  // Downloads a catalog model whole. Answers when it is on disk; one download per model at a time.
  // beforeReplace(): called just before an installed copy is replaced, so whoever holds its files open lets go.
  async function download(model, { signal = null, beforeReplace = async () => {} } = {}) {
    if (downloads.get(model.id)?.status === 'downloading') {
      throw new ApplicationError('embedding_model_downloading', 'This model is already downloading.', { status: 409 });
    }
    const state = { status: 'downloading', receivedBytes: 0, totalBytes: embeddingModelBytes(model), reason: null };
    downloads.set(model.id, state);
    const partial = join(directory, `${PARTIAL_PREFIX}${model.id}`);
    try {
      rmSync(partial, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      mkdirSync(partial, { recursive: true });
      for (const file of model.files) await fetchFile(file, join(partial, file.path), state, signal);
      // The spec is written last: only a folder that has it is a model.
      writeFileSync(join(partial, MODEL_SPEC_FILE), `${JSON.stringify({
        id: model.id, revision: model.revision, dimensions: model.dimensions, bytes: state.totalBytes,
        pooling: model.pooling, lowercase: model.lowercase, stripAccents: model.stripAccents, maxTokens: model.maxTokens,
        files: Object.fromEntries(model.files.map(file => [file.path, file.sha256]))
      }, null, 2)}\n`);
      const final = join(directory, model.id);
      if (existsSync(final)) await beforeReplace();
      rmSync(final, { recursive: true, force: true });
      renameSync(partial, final);
      downloads.delete(model.id);
      return { id: model.id, bytes: state.totalBytes };
    } catch (error) {
      discard(partial);
      downloads.set(model.id, { ...state, status: 'failed', reason: error?.code ?? 'embedding_model_unavailable' });
      throw error;
    }
  }

  function remove(id) {
    if (!EMBEDDING_MODEL_ID.test(id)) throw new TypeError('Unknown embedding model');
    if (downloads.get(id)?.status === 'downloading') {
      throw new ApplicationError('embedding_model_downloading', 'This model is downloading; wait for it to finish.', { status: 409 });
    }
    downloads.delete(id);
    const existed = existsSync(join(directory, id));
    rmSync(join(directory, id), { recursive: true, force: true });
    return { id, removed: existed };
  }

  return { installed, progress, download, remove };
}
