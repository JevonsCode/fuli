import { inspectAgent } from '../agent-kits/client-detection.js';
import { CLIENT_COMPONENT_UNAVAILABLE } from '../agent-kits/client-installer.js';

// Steps that mean the person restarts or reloads the client to load FULI.
const RESTART_CODES = new Set(['restart_client', 'reload_config']);
// Steps FULI has no wording of its own for; the installer's English text is shown.
const SHOWN_CODES = new Set(['trust_hooks', 'other']);
const UNKNOWN_OUTCOME = 'agent-installer did not answer in time, so the client may or may not have changed. '
  + 'FULI did not retry; run fuli setup again to check it.';

// Connects one client through agent-installer (the client installer port),
// which backs up every file it changes first. Shared by CLI setup and the
// local console. agent: { id, label }. Answers { id, label, status:
// 'connected' | 'partial' | 'failed', message?, reason?, restartRequired,
// newTaskRequired?, nextSteps?, selfCheck? }; `reason` is
// 'client_component_unavailable' when agent-installer cannot be had here.
export async function installAgent(installer, agent) {
  let answer;
  try {
    answer = await installer.apply([agent.id]);
  } catch (error) {
    return failed(agent, error?.code === 'unknown_outcome' ? UNKNOWN_OUTCOME
      : error instanceof Error ? error.message : 'Agent connection failed');
  }
  if (answer.status !== 'available') {
    return { ...failed(agent, CLIENT_COMPONENT_UNAVAILABLE), reason: 'client_component_unavailable' };
  }
  const client = answer.clients.find(({ id }) => id === agent.id);
  if (!client) return failed(agent, 'agent-installer did not answer for this client');
  const connected = connectedResult(agent, client);
  if (client.problems.length) return { ...connected, status: 'partial', message: client.problems.join('; ') };
  const inspected = await inspectAgent(installer, agent.id);
  if (!inspected) return connected;
  if (inspected.integrationStatus !== 'connected') {
    const failedChecks = Object.entries(inspected.integrationDetails ?? {})
      .filter(([, state]) => state !== 'current')
      .map(([component, state]) => `${component}=${state}`);
    return { ...connected, status: 'partial', selfCheck: { status: 'failed', details: inspected.integrationDetails },
      message: `Self-check failed (${failedChecks.join(', ') || inspected.integrationStatus})` };
  }
  return { ...connected, selfCheck: { status: 'passed', details: inspected.integrationDetails } };
}

// A changed client without a step of its own (an MCP-only client) reads
// its configuration at launch.
function connectedResult(agent, client) {
  const codes = client.actionCodes;
  const nextSteps = [...client.actions.filter((_, index) => SHOWN_CODES.has(codes[index])), ...(client.nextSteps ?? [])];
  return {
    id: agent.id,
    label: agent.label,
    status: 'connected',
    restartRequired: codes.some((code) => RESTART_CODES.has(code)) || (client.changes.length > 0 && codes.length === 0),
    ...(codes.includes('new_session') ? { newTaskRequired: true } : {}),
    ...(nextSteps.length ? { nextSteps } : {})
  };
}

function failed(agent, message) {
  return { id: agent.id, label: agent.label, status: 'failed', message };
}
