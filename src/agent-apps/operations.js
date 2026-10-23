// One decision on an app (approve, rollback, disable, code or data deletion,
// export) in the serial order of rec#7 D-28.9 and D-28.21: an instance this
// process hosts is sealed and stopped first (its tokens end with it); then the
// app's owner lease is taken, which refuses while another live FULI process
// holds it; then, inside the app's write gate, what an exited owner left is
// reconciled and the work runs. work(lease) checks the fence in each of its
// transactions and before each data file operation. The lease and the gate
// are released only after the work, with all its file I/O, has finished.
// keepInstance: an export, which refuses a running instance instead of
// stopping it.
export function createAppOperations(context) {
  const { leases, gates, instances, now } = context;

  async function run(appId, operation, work, { keepInstance = false } = {}) {
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
  }

  return { run };
}
