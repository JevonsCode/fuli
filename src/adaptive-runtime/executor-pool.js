export function createExecutorPool({
  adapters = new Map(),
  idleMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const entries = new Map();
  let closed = false;

  async function acquire(executorId, leaseId) {
    assertExecutorId(executorId);
    if (closed) throw new Error('Executor pool is closed');
    const entry = entryFor(executorId);
    if (entry.timer) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
    entry.leases.add(leaseId);
    if (!entry.adapter) {
      entry.stage = 'external';
      return snapshotEntry(executorId, entry);
    }
    await exclusive(entry, async () => {
      if (entry.stage !== 'running') {
        entry.stage = 'starting';
        try {
          await entry.adapter.start({ executorId });
          entry.stage = 'running';
          entry.lastError = null;
        } catch (error) {
          entry.leases.delete(leaseId);
          entry.stage = 'failed';
          entry.lastError = errorMessage(error);
          throw error;
        }
      }
    });
    return snapshotEntry(executorId, entry);
  }

  function release(executorId, leaseId) {
    const entry = entries.get(executorId);
    if (!entry) return;
    entry.leases.delete(leaseId);
    if (!entry.adapter || entry.leases.size > 0 || entry.timer || closed) return;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (entry.leases.size > 0 || closed) return;
      void exclusive(entry, async () => {
        if (entry.leases.size > 0 || closed) return;
        await stopEntry(executorId, entry);
      });
    }, idleMs);
    entry.timer?.unref?.();
  }

  async function stopEntry(executorId, entry) {
    entry.stage = 'stopping';
    try {
      await entry.adapter.stop({ executorId });
      entry.stage = 'idle';
      entry.lastError = null;
    } catch (error) {
      entry.stage = 'failed';
      entry.lastError = errorMessage(error);
    }
  }

  function status() {
    return [...entries.entries()].map(([executorId, entry]) =>
      snapshotEntry(executorId, entry));
  }

  function close() {
    closed = true;
    for (const entry of entries.values()) {
      if (entry.timer) clearTimer(entry.timer);
      entry.timer = null;
    }
  }

  function entryFor(executorId) {
    let entry = entries.get(executorId);
    if (!entry) {
      entry = {
        adapter: adapters.get(executorId) ?? null,
        leases: new Set(),
        timer: null,
        transition: Promise.resolve(),
        stage: adapters.has(executorId) ? 'idle' : 'external',
        lastError: null
      };
      entries.set(executorId, entry);
    }
    return entry;
  }

  return { acquire, release, status, close };
}

function exclusive(entry, operation) {
  const result = entry.transition.then(operation, operation);
  entry.transition = result.catch(() => {});
  return result;
}

function snapshotEntry(executorId, entry) {
  return {
    executorId,
    managed: Boolean(entry.adapter),
    stage: entry.stage,
    activeLeaseCount: entry.leases.size,
    lastError: entry.lastError
  };
}

function assertExecutorId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new TypeError('executorId must be non-empty text with at most 200 characters');
  }
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}
