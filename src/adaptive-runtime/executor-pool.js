const STOP_FAILURE_RETRY_MS = 30_000;

export function createExecutorPool({
  adapters = new Map(),
  idleMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const entries = new Map();
  let closed = false;
  let closePromise = null;

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
      if (closed) throw new Error('Executor pool is closed');
      if (entry.stage !== 'running') {
        try {
          if (entry.stage === 'failed' && !await stopEntry(executorId, entry)) {
            throw new Error(entry.lastError);
          }
          entry.stage = 'starting';
          await entry.adapter.start({ executorId });
          entry.stage = 'running';
          entry.lastStartError = null;
          entry.lastError = null;
        } catch (error) {
          entry.leases.delete(leaseId);
          if (entry.stage === 'starting') entry.lastStartError = errorMessage(error);
          entry.stage = 'failed';
          entry.lastError = errorMessage(error);
          throw error;
        }
      }
    });
    if (closed) throw new Error('Executor pool is closed');
    return snapshotEntry(executorId, entry);
  }

  function release(executorId, leaseId) {
    const entry = entries.get(executorId);
    if (!entry) return;
    entry.leases.delete(leaseId);
    // Runtime entries are live lease bookkeeping, not durable Agent identities.
    // External hosts have no resources owned by this pool after their last lease.
    if (!entry.adapter && entry.leases.size === 0) {
      entries.delete(executorId);
      return;
    }
    scheduleStop(executorId, entry, idleMs);
  }

  function scheduleStop(executorId, entry, delay) {
    if (!entry.adapter || entry.leases.size > 0 || entry.timer || closed) return;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (entry.leases.size > 0 || closed) return;
      void exclusive(entry, async () => {
        if (entry.leases.size > 0 || closed) return;
        if (!await stopEntry(executorId, entry)) {
          scheduleStop(executorId, entry, STOP_FAILURE_RETRY_MS);
        }
      });
    }, delay);
    entry.timer?.unref?.();
  }

  async function stopEntry(executorId, entry) {
    entry.stage = 'stopping';
    try {
      await entry.adapter.stop({ executorId });
      entry.stage = 'idle';
      entry.lastError = entry.lastStartError;
      return true;
    } catch (error) {
      entry.stage = 'failed';
      entry.lastError = errorMessage(error);
      return false;
    }
  }

  function status() {
    return [...entries.entries()].map(([executorId, entry]) =>
      snapshotEntry(executorId, entry));
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const shutdowns = [];
    for (const [executorId, entry] of entries) {
      if (entry.timer) clearTimer(entry.timer);
      entry.timer = null;
      entry.leases.clear();
      if (entry.adapter) shutdowns.push(exclusive(entry, async () => {
        if (entry.stage !== 'idle' && !await stopEntry(executorId, entry)) {
          throw new Error(`Failed to stop managed executor ${executorId}: ${entry.lastError}`);
        }
      }));
    }
    closePromise = Promise.allSettled(shutdowns).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length) {
        throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
      }
    });
    return closePromise;
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
        lastStartError: null,
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
