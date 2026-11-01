// The one place FULI learns which agent clients are on this machine and
// whether FULI is in each (rec#11 D-79): agent-installer's `status` for
// FULI's product manifest. FULI's writers still install; they only say where
// they edit (agentTargets in src/setup/agents.js).

// FULI's client IDs that agent-installer names differently.
const INSTALLER_ID = Object.freeze({ gemini: 'gemini-cli' });
const FULI_ID = Object.freeze(Object.fromEntries(Object.entries(INSTALLER_ID).map(([fuli, installer]) => [installer, fuli])));
// Component states that mean some of FULI is in the client.
const PRESENT = new Set(['current', 'outdated', 'conflict']);

// installer: the client installer port (client-installer.js). Answers
// { status: 'available', clients } or { status: 'unavailable', reason }.
// Each client: { id (FULI's), label, builtin, detected, manual, connected,
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
    id: FULI_ID[client.id] ?? client.id,
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

// FULI's writer targets with what agent-installer found in each, in the
// shape setup, uninstall and start read: `available` (the client is on this
// machine and FULI may write it), `integrationStatus` and
// `integrationDetails` (component states). A target the installer does not
// list is left out.
export async function detectAgents(installer, targets) {
  const answer = await detectClients(installer);
  if (answer.status !== 'available') return answer;
  const clients = new Map(answer.clients.map((client) => [client.id, client]));
  return { status: 'available', agents: targets.flatMap((target) => {
    const client = clients.get(target.id);
    if (!client) return [];
    return [{ ...target, available: client.detected, ...(client.manual ? { manualOnly: true } : {}),
      integrationStatus: client.connected ? 'connected' : hasFuli(client) ? 'update_available' : 'not_connected',
      integrationDetails: client.components }];
  }) };
}

// One target as agent-installer finds it now, or null when it cannot say:
// the self-check after FULI's writer connected it.
export async function inspectAgent(installer, target) {
  const answer = await detectAgents(installer, [target]);
  return answer.status === 'available' ? answer.agents[0] ?? null : null;
}
