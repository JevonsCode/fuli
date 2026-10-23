// The in-process write gate of each app (rec#7 D-28.17): one asynchronous
// mutex per app id, entered in arrival order. A write tool holds it for its
// whole run, including the file I/O it started; sealing an instance, data
// deletion, export and an instance start hold it too, so nothing of this
// process writes an app's data beside them. It serializes this process only;
// across processes the owner lease and its fence (owner-lease.js) decide.
export function createWriteGates() {
  const gates = new Map();

  const gateOf = (appId) => {
    if (!gates.has(appId)) gates.set(appId, { tail: Promise.resolve(), holder: null });
    return gates.get(appId);
  };

  // Resolves with leave() once every earlier holder has left. holder names who
  // waits or holds it ({ taskId, toolName, since }) for seal_waiting_for_writes.
  function enter(appId, holder) {
    const gate = gateOf(appId);
    const previous = gate.tail;
    let open;
    gate.tail = new Promise((resolve) => { open = resolve; });
    return previous.then(() => {
      gate.holder = holder;
      return () => {
        gate.holder = null;
        open();
      };
    });
  }

  async function run(appId, holder, work) {
    const leave = await enter(appId, holder);
    try {
      return await work();
    } finally {
      leave();
    }
  }

  return { enter, run, holder: (appId) => gates.get(appId)?.holder ?? null };
}
