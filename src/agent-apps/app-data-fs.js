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
// An operation the tool awaited (or gave a handler) reports its failure to
// the tool; whether it did is known once its then() was called.
class PortOperation extends Promise {
  then(onFulfilled, onRejected) {
    this.observed = true;
    return super.then(onFulfilled, onRejected);
  }
}
const observe = (operation, onFulfilled, onRejected) => Promise.prototype.then.call(operation, onFulfilled, onRejected);

// readOnly: a read tool's port, which refuses every change (read_only_port).
// unobservedFailure(): after drained(), the first failure of an operation the
// tool started and never looked at; the host fails the call with it.
export function createAppDataFs({ callId, toolName, root, fs, assertOwned, onClosedUse, readOnly = false }) {
  let closed = false;
  let pending = 0;
  let wake = null;
  const failures = [];

  function operation(op, path, perform, { writes = false } = {}) {
    if (closed) {
      onClosedUse({ toolName, callId, op });
      return Promise.reject(appConflict('write_port_closed',
        'This tool call has ended; its data port accepts no further operations', { toolName, callId, op }));
    }
    if (writes && readOnly) {
      return Promise.reject(appForbidden('read_only_port', 'A read tool cannot change the app data', { toolName, op }));
    }
    // Counted before any await, and until its outcome is recorded.
    pending += 1;
    const running = (async () => {
      assertOwned();
      const target = await resolveInside(path);
      // The fence again right before the change, after the awaited checks.
      assertOwned();
      return perform(target);
    })();
    const tracked = new PortOperation((resolve, reject) => { observe(running, resolve, reject); });
    const done = () => {
      pending -= 1;
      if (pending === 0) wake?.();
    };
    observe(tracked, done, (error) => {
      failures.push({ error, tracked });
      done();
    });
    return tracked;
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
    readFile: (path) => operation('readFile', path, (target) => fs.readFile(target)),
    writeFile: (path, data) => operation('writeFile', path, (target) => fs.writeFile(target, data), { writes: true }),
    readdir: (path) => operation('readdir', path, (target) => fs.readdir(target)),
    mkdir: (path) => operation('mkdir', path, (target) => fs.mkdir(target, { recursive: true }), { writes: true }),
    rm: (path) => operation('rm', path, (target) => fs.rm(target, { recursive: true, force: true }), { writes: true })
  });

  return {
    port,
    // Synchronous: from here on no new operation starts.
    close() { closed = true; },
    pending: () => pending,
    drained: () => (pending === 0 ? Promise.resolve() : new Promise((resolve) => { wake = resolve; })),
    unobservedFailure: () => failures.find(({ tracked }) => !tracked.observed)?.error ?? null
  };
}
