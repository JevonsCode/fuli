import { clientSourceApplication, entryState } from '../agent-kits/client-detection.js';

// Remember a problem until a successful scan sees it clear. Doctor polling
// and opening the report should not fill the local log with the same failure.
export function observeMcpDiagnostics(observe, log) {
  const previous = new Map();
  let pending = null;
  function record(client, code) {
    if (!code) { previous.delete(client); return; }
    if (previous.get(client) === code) return;
    if (log.record({ component: 'mcp', operation: `configuration.${client}`, code, outcome: 'failed' }))
      previous.set(client, code);
  }

  async function inspect() {
    let result;
    try { result = await observe(); }
    catch (error) { record('scan', 'mcp_detection_unavailable'); throw error; }
    record('scan', result.available ? null : result.diagnosticCode ?? 'mcp_detection_unavailable');
    if (result.available) {
      for (const client of result.clients) {
        const source = clientSourceApplication(client.id);
        if (source) record(source, configurationProblem(client));
      }
    }
    return result;
  }
  return () => pending ??= inspect().finally(() => { pending = null; });
}

function configurationProblem(client) {
  if (client.configuredInstall?.exists === false) return 'mcp_target_missing';
  if (entryState(client.components) === 'conflict' || client.status === 'unknown') return 'mcp_config_unreadable';
  if (entryState(client.components) === 'outdated') return 'mcp_config_outdated';
  if (client.status === 'removed') return 'mcp_config_removed';
  if (client.previouslyConnected && entryState(client.components) === 'missing') return 'mcp_config_missing';
  return null;
}
