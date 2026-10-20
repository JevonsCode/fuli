import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { transcriptDigest } from '../conversations/transcript-guard.js';
import { writeJsonFileAtomic } from '../storage/json-file.js';

// The session layer of the capture settings (rec#5 C3, "这次别记"): which
// host sessions are paused, kept in the local runtime directory and never in
// the graph. One small record per session, keyed by its sessionId:
// { paused, since, by } plus a monotonic generation. A new session has no
// record, so a pause ends with the session it was said in (C3-4).
//
// A worker or sub-Agent session started by another session links to it, so a
// pause of the parent, said before or after the child started, applies to the
// child too (C3-6). The child's own record cannot resume a paused parent.
//
// The generation moves on every pause, resume and link, and is part of the
// settings version the transcript capture compares
// (conversations/transcript-capture-gap.js): a turn written while the pause
// changed is never imported, and a capture that started before a pause cannot
// write after it (conversations/capture-window.js).

const RECORD_VERSION = 1;
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
// Worker links nest a few levels at most; a longer or cyclic chain cannot be
// trusted to say whether a parent paused.
const MAX_SESSION_CHAIN = 8;
const MAX_SESSION_ID_LENGTH = 256;
// Only an Agent pauses a session today, on the person's request in that session.
const PAUSED_BY = Object.freeze(['agent']);

export class SessionCapturePauseStore {
  constructor(directory = null, { now = () => new Date().toISOString(),
    readText = file => readFileSync(file, 'utf8') } = {}) {
    this.directory = directory ? resolve(directory) : null;
    this.now = now;
    this.readText = readText;
    this.memory = new Map();
  }

  // How a session is captured now: paused when it or a session that started it
  // is paused. version names every record the answer rests on, or is null when
  // the session has none. Throws when a record cannot be read or understood:
  // an unknown pause is never taken for "not paused" (C3-5).
  state(sessionId) {
    const records = [];
    for (let current = sessionId; current; current = records.at(-1).parentSessionId) {
      if (records.length >= MAX_SESSION_CHAIN || records.some(record => record.sessionId === current)) {
        throw new Error('Session capture chain is too long or cyclic');
      }
      const record = this.#read(current);
      if (!record) break;
      records.push({ ...record, sessionId: current });
    }
    const paused = records.find(record => record.paused) ?? null;
    return { paused: Boolean(paused), since: paused?.since ?? null, by: paused?.by ?? null,
      version: records.length ? records.map(record => `${record.generation}:${record.nonce}`).join('>') : null };
  }

  // Pauses or resumes one session from now on. Earlier records stay; turns
  // written while paused are never imported after a resume.
  set(sessionId, { paused, by = 'agent', sourceApplication }) {
    if (typeof paused !== 'boolean') throw new TypeError('sessionPaused must be a boolean');
    if (!PAUSED_BY.includes(by)) throw new TypeError('Session pause must name who paused it');
    const current = this.#read(validSessionId(sessionId));
    const keepSince = paused && current?.paused;
    return this.#write(sessionId, current, { paused, since: keepSince ? current.since : paused ? this.now() : null,
      by: paused ? (keepSince ? current.by : by) : null, sourceApplication: requiredClient(sourceApplication) });
  }

  // Whether any session of this client is paused now. An Agent call whose
  // client names no host session cannot be shown to come from another one.
  anyPaused(sourceApplication) {
    const records = this.directory ? this.#allRecords()
      : [...this.memory.values()];
    return records.some(record => record.paused && record.sourceApplication === sourceApplication);
  }

  #allRecords() {
    let names;
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error('Session capture pauses could not be listed');
    }
    return names.filter(name => RECORD_FILE.test(name)).map(name => this.#readFile(join(this.directory, name)));
  }

  // Records that childSessionId was started by parentSessionId.
  link(childSessionId, parentSessionId) {
    validSessionId(parentSessionId);
    if (childSessionId === parentSessionId) throw new TypeError('A session cannot start itself');
    const current = this.#read(validSessionId(childSessionId));
    this.#write(childSessionId, current, { paused: current?.paused ?? false, since: current?.since ?? null,
      by: current?.by ?? null, sourceApplication: current?.sourceApplication ?? null, parentSessionId });
  }

  #write(sessionId, current, fields) {
    const next = { version: RECORD_VERSION, generation: (current?.generation ?? 0) + 1, nonce: randomUUID(),
      parentSessionId: current?.parentSessionId ?? null, ...fields };
    if (this.directory) writeJsonFileAtomic(this.#path(sessionId), next);
    else this.memory.set(sessionId, next);
    return { paused: next.paused, since: next.since, by: next.by };
  }

  // A missing record is null: the session was never paused or linked, or its
  // record was removed, which moves the version like any other change.
  #read(sessionId) {
    if (!this.directory) return this.memory.get(sessionId) ?? null;
    return this.#readFile(this.#path(sessionId));
  }

  #readFile(path) {
    let value;
    try {
      value = JSON.parse(this.readText(path));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error('Session capture pause could not be read');
    }
    if (!validRecord(value)) throw new Error('Session capture pause is invalid');
    return value;
  }

  #path(sessionId) {
    return join(this.directory, `${transcriptDigest(sessionId)}.json`);
  }
}

export function sessionCapturePausePathForRuntime(runtimeConfigPath) {
  if (!runtimeConfigPath) return null;
  return join(dirname(resolve(runtimeConfigPath)), 'capture-session-pause');
}

function validSessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SESSION_ID_LENGTH) {
    throw new TypeError('Session capture pause requires a host session');
  }
  return value;
}

function requiredClient(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('Session capture pause must name its client');
  return value;
}

function validRecord(value) {
  return value?.version === RECORD_VERSION && Number.isSafeInteger(value.generation) && value.generation > 0
    && typeof value.nonce === 'string' && typeof value.paused === 'boolean'
    && (value.paused ? typeof value.since === 'string' && PAUSED_BY.includes(value.by)
      : value.since === null && value.by === null)
    && (value.sourceApplication === null || typeof value.sourceApplication === 'string')
    && (value.parentSessionId === null || (typeof value.parentSessionId === 'string' && value.parentSessionId.length > 0));
}
