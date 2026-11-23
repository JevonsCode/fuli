// The one place FULI learns which agent clients are on this machine and
// whether FULI is in each (rec#11 D-79): agent-installer's `status` for
// FULI's product manifest, through the client installer port.

// Component states that mean some of FULI is in the client.
const PRESENT = new Set(['current', 'outdated', 'conflict']);

// The source application each client's MCP entry names (the descriptor packs and
// fuli-installer-manifest.json). The clients that say 'other' can't be told
// apart, so nothing about their open sessions can be said.
const SOURCES = Object.freeze({ codex: 'codex', 'claude-code': 'claude_code', cursor: 'cursor', opencode: 'opencode',
  'claude-desktop': 'claude', kiro: 'kiro', antigravity: 'antigravity', dsh: 'dsh' });
export const clientSourceApplication = id => SOURCES[id] ?? null;

// The component that carries FULI's entry in a client: its MCP entry, or, in
// a client with no MCP file (DeepSeek Harness), the plugin bundle that starts
// FULI's MCP server itself. `components`: component name to state.
export const entryComponent = (components) => ('mcp' in (components ?? {}) ? 'mcp' : 'plugin');
export const entryState = (components) => components?.[entryComponent(components)];

// installer: the client installer port (client-installer.js). Answers
// { status: 'available', clients } or { status: 'unavailable', reason }.
// Each client: { id, label, builtin, detected, manual, connected,
// components: { mcp: 'current' | 'outdated' | 'missing' | 'conflict', … },
// mcpPaths, entryPaths }. entryPaths are the files or directories of the
// entry component (entryComponent). Clients this platform cannot run are left out.
//
// presence (client-presence.js, optional): also counts a built-in client as on
// this computer when its own command is installed here. agent-installer reads
// FULI's PATH and each client's configuration files, so without this a client
// that has never written its configuration is never connected and never
// reported as installed (rec#145).
// wait: false (a status page) answers from the last probes and never waits for a shell.
export async function detectClients(installer, { presence = null, wait = true } = {}) {
  const answer = await installer.status();
  if (answer.status !== 'available') return answer;
  const clients = answer.clients.filter((client) => client.platformSupported).map(clientOf);
  if (!presence) return { status: 'available', clients };
  const missed = clients.filter((client) => client.builtin && !client.detected && !client.manual).map(({ id }) => id);
  // A shell that cannot be started tells us nothing new; agent-installer's answer stands.
  const found = missed.length ? await presence.find(missed, { wait }).catch(() => null) : null;
  return { status: 'available', clients: clients.map((client) => {
    if (found?.installed.has(client.id)) return { ...client, detected: true };
    // Only inside WSL: not on this computer for FULI, which says so (client-presence.js).
    if (found?.inWsl.has(client.id)) return { ...client, inWsl: true };
    // Its command is still being looked for: not yet known to be missing.
    return found?.pending?.has(client.id) ? { ...client, probing: true } : client;
  }) };
}

// The MCP files of every client in an installer status answer, on this
// platform or not: the files a client described by hand may not name.
export const listedMcpFiles = (clients) => clients.flatMap((client) => (client.componentStates ?? [])
  .filter(({ component }) => component === 'mcp').flatMap(({ paths }) => paths ?? []));

// What agent-installer says about an entry it cannot use (for example "Invalid
// JSON."), bounded: shown to the person as it is, never interpreted.
const MAX_PROBLEM = 200;

function clientOf(client) {
  const states = client.componentStates.filter(({ state }) => state !== 'unsupported');
  const components = Object.fromEntries(states.map(({ component, state }) => [component, state]));
  const pathsOf = (name) => states.find(({ component }) => component === name)?.paths ?? [];
  const entry = states.find(({ component }) => component === entryComponent(components));
  const problem = entry?.state === 'conflict' && typeof entry.message === 'string' ? entry.message.slice(0, MAX_PROBLEM) : null;
  return {
    ...(problem ? { entryProblem: problem } : {}),
    id: client.id,
    label: client.name,
    builtin: client.builtin,
    detected: client.detected,
    manual: client.state === 'manual',
    connected: client.state === 'connected',
    components,
    mcpPaths: pathsOf('mcp'),
    entryPaths: pathsOf(entryComponent(components))
  };
}

const hasFuli = (client) => Object.values(client.components).some((state) => PRESENT.has(state));

// One client in the shape setup, uninstall and start read: `available` (the
// client is on this machine), `manualOnly` (the person configures it by
// hand), `integrationStatus` and `integrationDetails` (component states).
const agentOf = (client) => ({
  id: client.id, label: client.label, available: client.detected, ...(client.manual ? { manualOnly: true } : {}),
  ...(client.inWsl ? { inWsl: true } : {}),
  integrationStatus: client.connected ? 'connected' : hasFuli(client) ? 'update_available' : 'not_connected',
  integrationDetails: client.components });

// The built-in clients FULI sets up.
export async function detectAgents(installer, options) {
  const answer = await detectClients(installer, options);
  if (answer.status !== 'available') return answer;
  return { status: 'available', agents: answer.clients.filter((client) => client.builtin).map(agentOf) };
}

// One client as agent-installer finds it now, built-in or described by hand,
// or null when it cannot say: the self-check after a connection.
export async function inspectAgent(installer, id) {
  const answer = await detectClients(installer);
  const client = answer.status === 'available' ? answer.clients.find((candidate) => candidate.id === id) : null;
  return client ? agentOf(client) : null;
}
