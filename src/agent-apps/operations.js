// One decision on an app (approve, rollback, disable, code or data deletion,
// export) in the serial order of rec#7 D-28.9 and D-28.21. It runs inside the
// app's lifecycle in this process (instances.js), so a start still in flight
// completes first and a stop in flight finishes first. Then an instance this
// process hosts is sealed and stopped (its tokens end with it); then the
// app's owner lease is taken, which refuses while another live FULI process
// holds it; then, inside the app's write gate, what an exited owner left is
// reconciled and the work runs. work(lease) checks the fence in each of its
// transactions and before each data file operation. The lease and the gate
// are released only after the work, with all its file I/O, has finished.
// keepInstance: an export, which refuses a running instance instead of
// stopping it. While this process closes (instances.js) no operation is admitted.
export function createAppOperations(context) {
  const { leases, gates, lifecycles, instances, now } = context;

  function run(appId, operation, work, { keepInstance = false } = {}) {
    return instances.admit(() => lifecycles.run(appId, { toolName: operation }, async () => {
      instances.assertOpen();
      if (!keepInstance) await instances.end(appId, operation);
      const lease = await leases.acquire(appId);
      try {
        return await gates.run(appId, { toolName: operation, since: now() }, async () => {
          await instances.reconcile(appId, lease);
          return await work(lease);
        });
      } finally {
        leases.release(lease);
      }
    }));
  }

  return { run };
}
