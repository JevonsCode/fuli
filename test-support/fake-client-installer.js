// A client installer port (src/agent-kits/client-installer.js) kept in
// memory, for tests of what FULI does with agent-installer's answers. No file
// is read or written. clients: [{ id, state?, mcp?, detected?, builtin? }].
// apply marks a client connected (or `afterApply`), unless it has problems;
// remove marks it not connected. `calls` records every write.
export function fakeClientInstaller(clients, { unavailable = null, problems = {}, actionCodes = {}, afterApply = 'connected' } = {}) {
  const states = new Map(clients.map((client) => [client.id, { builtin: true, detected: true, platformSupported: true,
    state: 'not_connected', mcp: 'missing', ...client }]));
  const calls = [];
  const view = (client) => ({ id: client.id, name: client.name ?? client.id, builtin: client.builtin, detected: client.detected,
    platformSupported: client.platformSupported, state: client.state, componentStates: [{ component: 'mcp', state: client.mcp }] });
  const result = (id, changed) => ({ id, name: id, state: states.get(id).state,
    changes: changed ? [{ path: `~/.${id}/config.json`, components: ['mcp'], action: 'update', diff: `+ ${id}` }] : [],
    problems: problems[id] ?? [], actions: (actionCodes[id] ?? []).map((code) => `Step ${code}.`), actionCodes: actionCodes[id] ?? [] });
  async function write(action, ids) {
    calls.push([action, ids]);
    if (unavailable) return { status: 'unavailable', reason: unavailable };
    const answered = ids.map((id) => {
      const client = states.get(id);
      const before = client.state;
      if (action === 'apply' && !problems[id]) Object.assign(client, { state: afterApply, mcp: afterApply === 'connected' ? 'current' : 'outdated' });
      if (action === 'remove') Object.assign(client, { state: 'not_connected', mcp: 'missing' });
      return result(id, action === 'plan' ? before !== 'connected' : before !== client.state);
    });
    return { status: 'available', partial: answered.some((client) => client.problems.length > 0), extensionErrors: [],
      problems: answered.flatMap((client) => client.problems.map((message) => ({ client: client.id, message }))), clients: answered };
  }
  return {
    calls,
    extensionsDir: null,
    status: async () => (unavailable ? { status: 'unavailable', reason: unavailable }
      : { status: 'available', extensionErrors: [], clients: [...states.values()].map(view) }),
    plan: (ids) => write('plan', ids),
    apply: (ids) => write('apply', ids),
    remove: (ids) => write('remove', ids)
  };
}
