import { join } from 'node:path';

import { appConflict, appForbidden } from './errors.js';

// A relative path inside data/<appId>: visible segments, no "..", no root,
// drive or backslash.
const SEGMENT = /^(?!\.\.?$)[^/\\:\0]+$/;

export function isDataPath(path) {
  return typeof path === 'string' && path !== '' && path.split('/').every((segment) => SEGMENT.test(segment));
}

// The only way a host tool touches its app's data directory (rec#7 D-28.26,
// D-28.31). The host makes one port per tool call, bound to { appId, callId,
// lease }, hands it to that call only and closes it the moment the call
// settles. Each operation is counted in flight before anything else happens,
// so the host can wait for all of them (drained) before it commits and lets
// the write gate and the owner lease go. A closed port refuses every further
// operation (write_port_closed) before it looks at the fence or the disk; an
// open one first checks the owner fence (write_fenced), then that the data
// root is a real directory and not a link (data_root_missing: the port never
// creates the root, only activation does), then that no part of the path
// below it is a link. fs is node:fs/promises in production; root is data/<appId>.
// The failure contract (rec#10 round 3): any port operation that fails makes
// the whole tool call fail, after the drain and before any commit, whether
// the tool awaited it, caught it, chained it or ignored it. The one exception
// is an operation the tool opted out for by error code, for example
// readFile(path, { tolerate: ['ENOENT'] }) for a file that may not exist yet:
// that failure still rejects to the tool but does not fail the call. Every
// operation carries an internal rejection handler, and so does every promise
// a tool derives from it (then, catch, finally), so a failure never becomes
// an unhandledRejection of the host process.
class PortOperation extends Promise {
  then(onFulfilled, onRejected) {
    const derived = super.then(onFulfilled, onRejected);
    Promise.prototype.then.call(derived, undefined, () => {});
    return derived;
  }
}

const OPTION_KEYS = new Set(['tolerate']);

function toleratedCodes(options, op) {
  if (options === undefined) return [];
  const keys = options !== null && typeof options === 'object' ? Object.keys(options) : null;
  if (!keys || keys.some((key) => !OPTION_KEYS.has(key)) || (options.tolerate !== undefined
    && (!Array.isArray(options.tolerate) || !options.tolerate.every((code) => typeof code === 'string' && code)))) {
    throw new TypeError(`${op} options are { tolerate: [error codes] }`);
  }
  return options.tolerate ?? [];
}

// readOnly: a read tool's port, which refuses every change (read_only_port).
// failure(): after drained(), the first failure that was not tolerated; the
// host fails the call with it.
export function createAppDataFs({ callId, toolName, root, fs, assertOwned, onClosedUse, readOnly = false }) {
  let closed = false;
  let pending = 0;
  let wake = null;
  const failures = [];

  function operation(op, path, perform, options, { writes = false } = {}) {
    if (closed) {
      onClosedUse({ toolName, callId, op });
      const refused = PortOperation.reject(appConflict('write_port_closed',
        'This tool call has ended; its data port accepts no further operations', { toolName, callId, op }));
      Promise.prototype.then.call(refused, undefined, () => {});
      return refused;
    }
    // Counted before any await, and until its outcome is recorded.
    pending += 1;
    const running = (async () => {
      let tolerate = [];
      try {
        tolerate = toleratedCodes(options, op);
        if (writes && readOnly) throw appForbidden('read_only_port', 'A read tool cannot change the app data', { toolName, op });
        assertOwned();
        const target = await resolveInside(path);
        // The fence again right before the change, after the awaited checks.
        assertOwned();
        return await perform(target);
      } catch (error) {
        if (!tolerate.includes(error?.code)) failures.push(error);
        throw error;
      } finally {
        pending -= 1;
        if (pending === 0) wake?.();
      }
    })();
    const result = new PortOperation((resolve, reject) => { running.then(resolve, reject); });
    Promise.prototype.then.call(result, undefined, () => {});
    return result;
  }

  async function resolveInside(path) {
    if (path !== '.' && !isDataPath(path)) {
      throw appForbidden('scope_violation', 'A data path is relative and stays inside the app data directory',
        { field: 'path', toolName });
    }
    const rootEntry = await fs.lstat(root).catch(() => null);
    if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) {
      throw appConflict('data_root_missing', 'The app data directory is missing; only activating the app creates it');
    }
    let target = root;
    for (const segment of path === '.' ? [] : path.split('/')) {
      target = join(target, segment);
      const entry = await fs.lstat(target).catch(() => null);
      if (entry?.isSymbolicLink()) {
        throw appForbidden('scope_violation', 'A data path never passes through a link', { field: 'path', toolName });
      }
    }
    return target;
  }

  const port = Object.freeze({
    readFile: (path, options) => operation('readFile', path, (target) => fs.readFile(target), options),
    writeFile: (path, data, options) => operation('writeFile', path, (target) => fs.writeFile(target, data), options,
      { writes: true }),
    readdir: (path, options) => operation('readdir', path, (target) => fs.readdir(target), options),
    mkdir: (path, options) => operation('mkdir', path, (target) => fs.mkdir(target, { recursive: true }), options,
      { writes: true }),
    rm: (path, options) => operation('rm', path, (target) => fs.rm(target, { recursive: true, force: true }), options,
      { writes: true })
  });

  return {
    port,
    // Synchronous: from here on no new operation starts.
    close() { closed = true; },
    pending: () => pending,
    drained: () => (pending === 0 ? Promise.resolve() : new Promise((resolve) => { wake = resolve; })),
    failure: () => failures[0] ?? null
  };
}
