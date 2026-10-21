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
// The same record keeps whether FULI is on for the session (rec#5 C3b, the
// person's own /fuli start|stop|restart): enabled true or false, or null when
// the session follows the default for new sessions. A stop of the session, or
// of a session that started it, turns FULI off for it; a child's start cannot
// undo a parent's stop. The default is a separate setting (default.json). A
// session FULI sees at task entry keeps the default of that moment (pins/on,
// pins/off; the files under off say which sessions may be off), so
// a later change of the default applies to new sessions only, never to a
// window already open.
//
// A worker or sub-Agent session started by another session links to it, so a
// pause of the parent, said before or after the child started, applies to the
// child too (C3-6). The child's own record cannot resume a paused parent.
//
// The generation moves on every pause, resume, start, stop and link, and is
// part of the settings version the transcript capture compares
// (conversations/transcript-capture-gap.js): a turn written while the pause
// changed is never imported, and a capture that started before a pause cannot
// write after it (conversations/capture-window.js).

const RECORD_VERSION = 1;
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
const DEFAULT_FILE = 'default.json';
const PINS = 'pins';
// Worker links nest a few levels at most; a longer or cyclic chain cannot be
// trusted to say whether a parent paused.
const MAX_SESSION_CHAIN = 8;
const MAX_SESSION_ID_LENGTH = 256;
// Only an Agent pauses a session today, on the person's request in that session.
const PAUSED_BY = Object.freeze(['agent']);

export class SessionCapturePauseStore {
  constructor(directory = null, { now = () => new Date().toISOString(),
    readText = file => readFileSync(file, 'utf8'), writeJson = writeJsonFileAtomic } = {}) {
    this.directory = directory ? resolve(directory) : null;
    this.now = now;
    this.readText = readText;
    this.writeJson = writeJson;
    this.memory = new Map();
    this.memoryPins = new Map();
    this.memoryDefault = null;
  }

  // How a session is captured now: paused when it or a session that started it
  // is paused; stopped when FULI is off for it, and fuli.basis says whose stop
  // or start decides ('session', 'parent') or that the default it started under
  // does. version names every record the answer rests on, or is null when the
  // session has none. Throws when a record cannot be read or understood: an
  // unknown pause or stop is never taken for "not paused" or "on" (C3-5).
  state(sessionId) {
    const records = [], chain = [];
    for (let current = sessionId; current; current = records.at(-1).parentSessionId) {
      if (records.length >= MAX_SESSION_CHAIN || chain.includes(current)) {
        throw new Error('Session capture chain is too long or cyclic');
      }
      chain.push(current);
      const record = this.#read(current);
      if (!record) break;
      records.push({ ...record, sessionId: current });
    }
    const paused = records.find(record => record.paused) ?? null;
    const explicit = records.find(record => record.enabled === false) ?? records.find(record => record.enabled === true);
    const enabled = explicit ? explicit.enabled : this.#startedUnder(chain);
    return { paused: Boolean(paused), since: paused?.since ?? null, by: paused?.by ?? null, stopped: !enabled,
      fuli: { enabled, basis: !explicit ? 'default' : explicit.enabledBy === 'fuli' ? 'start_unsaved'
        : explicit.sessionId === sessionId ? 'session' : 'parent',
        since: explicit?.enabledSince ?? null },
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

  // Turns FULI on or off for one session from now on (rec#5 C3b).
  setEnabled(sessionId, { enabled, sourceApplication }) {
    if (typeof enabled !== 'boolean') throw new TypeError('The FULI session switch must be on or off');
    const current = this.#read(validSessionId(sessionId));
    this.#write(sessionId, current, { enabled, sourceApplication: requiredClient(sourceApplication), enabledBy: 'person',
      enabledSince: current?.enabled === enabled && current.enabledBy === 'person' ? current.enabledSince : this.now() });
  }

  // Whether new sessions start with FULI on. None saved means on; a setting
  // that cannot be read throws, so no session is taken for "on" by mistake.
  defaultSetting() {
    const value = this.directory ? this.#readJson(join(this.directory, DEFAULT_FILE)) : this.memoryDefault;
    if (value === null) return { enabled: true, since: null };
    if (value?.version !== RECORD_VERSION || typeof value.enabled !== 'boolean' || typeof value.since !== 'string') {
      throw new Error('FULI session default is invalid');
    }
    return { enabled: value.enabled, since: value.since };
  }

  // since is when the default last changed; saving the same value changes nothing.
  setDefault(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('The FULI session default must be on or off');
    const current = this.defaultSetting();
    if (current.enabled === enabled) return current;
    const value = { version: RECORD_VERSION, enabled, since: this.now() };
    if (this.directory) this.writeJson(join(this.directory, DEFAULT_FILE), value);
    else this.memoryDefault = value;
    return { enabled, since: value.since };
  }

  // Keeps, once, the default a session started under. fresh: the host's own
  // session-start event says the session begins now; otherwise it is the
  // session's first task entry. Once the default has been turned on, only a
  // fresh session can be shown to have started under on: any other may have
  // begun while the default was off and FULI could not save that, so it is
  // pinned off until the person starts it (Dot's review of #251). A pin that
  // cannot be saved is replaced by keeping the session off in its own record;
  // throws when neither is saved.
  pinDefault(sessionId, sourceApplication, { fresh = false } = {}) {
    validSessionId(sessionId);
    if (this.#pin(sessionId) !== null) return;
    const setting = this.defaultSetting();
    const enabled = setting.enabled && (setting.since === null || fresh === true);
    const value = { version: RECORD_VERSION, sourceApplication: requiredClient(sourceApplication) };
    if (!this.directory) {
      this.memoryPins.set(sessionId, { ...value, enabled });
      return;
    }
    try {
      this.writeJson(this.#pinPath(sessionId, enabled), value);
    } catch {
      const current = this.#read(sessionId);
      if ((current?.enabled ?? null) !== null) return;
      this.#write(sessionId, current, { enabled: false, enabledBy: 'fuli', enabledSince: this.now(), sourceApplication });
    }
  }

  // Whether a session of this client may be recording nothing now: one is
  // paused or stopped, or new sessions start with FULI off. An Agent call
  // whose client names no host session cannot be shown to come from another one.
  anyWithoutCapture(sourceApplication) {
    return !this.defaultSetting().enabled || this.#records().some(record =>
      (record.paused || record.enabled === false) && record.sourceApplication === sourceApplication)
      || this.#startedOff().some(pin => pin.sourceApplication === sourceApplication);
  }

  // Whether FULI may be off for any session at all: then a call needs a
  // closer look at its sessions. With a client, whether one of its sessions
  // FULI saw is off: stopped, or started off and not started since.
  anyStopped(sourceApplication = null) {
    const ofClient = item => sourceApplication === null || item.sourceApplication === sourceApplication;
    return (sourceApplication === null && !this.defaultSetting().enabled)
      || this.#records().some(record => record.enabled === false && ofClient(record))
      || this.#startedOff().some(ofClient);
  }

  // Sessions that started under a default of off and were not started since.
  #startedOff() {
    if (!this.directory) {
      return [...this.memoryPins].filter(([sessionId, pin]) => !pin.enabled && this.memory.get(sessionId)?.enabled !== true)
        .map(([, pin]) => pin);
    }
    const directory = join(this.directory, PINS, 'off');
    let names;
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error('FULI session pins could not be listed');
    }
    return names.filter(name => RECORD_FILE.test(name)
      && this.#readFile(join(this.directory, name))?.enabled !== true)
      .map(name => validPin(this.#readJson(join(directory, name))));
  }

  #records() {
    if (!this.directory) return [...this.memory.values()];
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
    this.#write(childSessionId, this.#read(validSessionId(childSessionId)), { parentSessionId });
  }

  // A change names only the fields it changes; the others keep their value.
  #write(sessionId, current, fields) {
    const next = { version: RECORD_VERSION, generation: (current?.generation ?? 0) + 1, nonce: randomUUID(),
      paused: current?.paused ?? false, since: current?.since ?? null, by: current?.by ?? null,
      sourceApplication: current?.sourceApplication ?? null, parentSessionId: current?.parentSessionId ?? null,
      enabled: current?.enabled ?? null, enabledSince: current?.enabledSince ?? null,
      enabledBy: current?.enabledBy ?? null, ...fields };
    if (this.directory) this.writeJson(this.#path(sessionId), next);
    else this.memory.set(sessionId, next);
    return { paused: next.paused, since: next.since, by: next.by };
  }

  // The default of the outermost session of the chain FULI saw start, else
  // the default now.
  #startedUnder(chain) {
    for (const sessionId of [...chain].reverse()) {
      const pinned = this.#pin(sessionId);
      if (pinned !== null) return pinned;
    }
    return this.defaultSetting().enabled;
  }

  // The default a session started under, or null when FULI never saw it start.
  #pin(sessionId) {
    if (!this.directory) return this.memoryPins.get(sessionId)?.enabled ?? null;
    for (const enabled of [false, true]) {
      const value = this.#readJson(this.#pinPath(sessionId, enabled));
      if (value !== null) return validPin(value) && enabled;
    }
    return null;
  }

  // A missing record is null: the session was never paused, switched or
  // linked, or its record was removed, which moves the version like any other change.
  #read(sessionId) {
    if (!this.directory) return this.memory.get(sessionId) ?? null;
    return this.#readFile(this.#path(sessionId));
  }

  #readFile(path) {
    const value = this.#readJson(path);
    if (value !== null && !validRecord(value)) throw new Error('Session capture pause is invalid');
    return value;
  }

  #readJson(path) {
    try {
      return JSON.parse(this.readText(path));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error('Session capture state could not be read');
    }
  }

  #path(sessionId) {
    return join(this.directory, `${transcriptDigest(sessionId)}.json`);
  }

  #pinPath(sessionId, enabled) {
    return join(this.directory, PINS, enabled ? 'on' : 'off', `${transcriptDigest(sessionId)}.json`);
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

function validPin(value) {
  if (value?.version !== RECORD_VERSION || typeof value.sourceApplication !== 'string') throw new Error('FULI session pin is invalid');
  return value;
}

function validRecord(value) {
  return value?.version === RECORD_VERSION && Number.isSafeInteger(value.generation) && value.generation > 0
    && typeof value.nonce === 'string' && typeof value.paused === 'boolean'
    && (value.paused ? typeof value.since === 'string' && PAUSED_BY.includes(value.by)
      : value.since === null && value.by === null)
    && (value.sourceApplication === null || typeof value.sourceApplication === 'string')
    && (value.parentSessionId === null || (typeof value.parentSessionId === 'string' && value.parentSessionId.length > 0))
    // Records saved before the session switch (rec#5 C3b) name neither field.
    && ((value.enabled ?? null) === null ? (value.enabledSince ?? null) === null && (value.enabledBy ?? null) === null
      : typeof value.enabled === 'boolean' && typeof value.enabledSince === 'string'
        // 'fuli': kept off because the session's starting default could not be saved.
        && [undefined, null, 'person', 'fuli'].includes(value.enabledBy));
}
