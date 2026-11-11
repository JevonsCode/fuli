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
// The copy a newer download replaces waits here until the new one is in place.
const RETIRED_PREFIX = '.retired-';
// Windows refuses to move or delete a file something still maps or scans; it lets go within moments.
const HELD = { maxRetries: 20, retryDelay: 100 };
const HELD_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
// What the file system says when it will not take a file.
const LOCAL_WRITE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
// A download that sends nothing for this long is given up.
const IDLE_TIMEOUT_MS = 60_000;

// How a model turns text into a vector besides its weights: a catalog fix to any of these gives
// other vectors from the same files, so it is part of what an index was built with.
export const embeddingSettingsTag = model => createHash('sha256')
  .update(JSON.stringify([model.pooling ?? null, model.lowercase ?? null, model.stripAccents ?? null, model.maxTokens ?? null]))
  .digest('hex').slice(0, 6);

export const embeddingModelsDirectory = dataDir => join(dataDir, 'models', 'embedding');

// rename(from, to) moves a folder; a test makes it fail the way a held file does.
export function createEmbeddingModelStore({ directory, fetchImpl = globalThis.fetch, idleTimeoutMs = IDLE_TIMEOUT_MS,
  openFile = createWriteStream, rename = renameSync }) {
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

  // The models that finished downloading: { id, revision, settings, dimensions, bytes }.
  function installed() {
    let names = [];
    try { names = readdirSync(directory); } catch { return []; }
    return names.map(id => ({ id, spec: spec(id) })).filter(entry => entry.spec)
      .map(({ id, spec: found }) => ({ id, revision: found.revision ?? null, settings: embeddingSettingsTag(found),
        dimensions: found.dimensions ?? null, bytes: found.bytes ?? null }));
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
        const local = notWritten(error);
        if (local) throw local;
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
      rmSync(folder, { recursive: true, force: true, ...HELD });
    } catch { /* The next download of this model removes it first. */ }
  }

  // A folder moves whole or not at all; one that is held for a moment is tried again.
  async function move(from, to) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return rename(from, to);
      } catch (error) {
        if (!HELD_CODES.has(error?.code) || attempt >= HELD.maxRetries) throw error;
        await new Promise(resolve => setTimeout(resolve, HELD.retryDelay));
      }
    }
  }

  // This computer refused the file: a full disk, or a folder FULI may not write. Trying another
  // source cannot help, and the person is told it is the disk, not the network (rec#117).
  const notWritten = error => (LOCAL_WRITE_CODES.has(error?.code)
    ? new ApplicationError('embedding_model_not_written', `The model could not be written on this computer (${error.code}).`, { status: 507 })
    : null);

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
      const retired = join(directory, `${RETIRED_PREFIX}${model.id}`);
      discard(retired);
      // The installed copy is moved aside, never deleted first: if anything fails from here on it
      // goes back, so a model in use is the old one or the new one and never half of either.
      const replacing = existsSync(final);
      if (replacing) {
        await beforeReplace();
        await move(final, retired);
      }
      try {
        await move(partial, final);
      } catch (error) {
        if (replacing) await move(retired, final).catch(() => {});
        throw error;
      }
      discard(retired);
      downloads.delete(model.id);
      return { id: model.id, bytes: state.totalBytes };
    } catch (cause) {
      const error = notWritten(cause) ?? cause;
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
    // Whole or not at all: the folder leaves its name first, so a file Windows still holds
    // never leaves half a model under the id.
    const retired = join(directory, `${RETIRED_PREFIX}${id}`);
    discard(retired);
    if (existed) rename(join(directory, id), retired);
    discard(retired);
    return { id, removed: existed };
  }

  return { installed, progress, download, remove };
}
