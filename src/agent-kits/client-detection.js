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

// installer: the client installer port (client-installer.js). Answers
// { status: 'available', clients } or { status: 'unavailable', reason }.
// Each client: { id, label, builtin, detected, manual, connected,
// components: { mcp: 'current' | 'outdated' | 'missing' | 'conflict', … },
// mcpPaths }. Clients this platform cannot run are left out.
export async function detectClients(installer) {
  const answer = await installer.status();
  if (answer.status !== 'available') return answer;
  return { status: 'available', clients: answer.clients.filter((client) => client.platformSupported).map(clientOf) };
}

function clientOf(client) {
  const states = client.componentStates.filter(({ state }) => state !== 'unsupported');
  return {
    id: client.id,
    label: client.name,
    builtin: client.builtin,
    detected: client.detected,
    manual: client.state === 'manual',
    connected: client.state === 'connected',
    components: Object.fromEntries(states.map(({ component, state }) => [component, state])),
    mcpPaths: states.find(({ component }) => component === 'mcp')?.paths ?? []
  };
}

const hasFuli = (client) => Object.values(client.components).some((state) => PRESENT.has(state));

// The built-in clients FULI sets up, in the shape setup, uninstall and start
// read: `available` (the client is on this machine), `manualOnly` (the
// person configures it by hand), `integrationStatus` and
// `integrationDetails` (component states).
export async function detectAgents(installer) {
  const answer = await detectClients(installer);
  if (answer.status !== 'available') return answer;
  return { status: 'available', agents: answer.clients.filter((client) => client.builtin).map((client) => ({
    id: client.id, label: client.label, available: client.detected, ...(client.manual ? { manualOnly: true } : {}),
    integrationStatus: client.connected ? 'connected' : hasFuli(client) ? 'update_available' : 'not_connected',
    integrationDetails: client.components })) };
}

// One client as agent-installer finds it now, or null when it cannot say:
// the self-check after a connection.
export async function inspectAgent(installer, id) {
  const answer = await detectAgents(installer);
  return answer.status === 'available' ? answer.agents.find((agent) => agent.id === id) ?? null : null;
}
