import { writeDerivedJson } from './derived-file.js';
import { fuliInstallerManifest, installerVariables } from './installer-manifest.js';

// agent-installer's `status` beside FULI's own inspection, in shadow mode
// (rec#11 D-79 step 2): the installer never writes, FULI's answer is what the
// person sees, and each client's agreement is kept where a developer can read
// it (the doctor report's `internal.installerShadow`). The next stage switches
// a client's writer only after this shows agreement for it.

// FULI's client IDs and the installer's, mapped once.
const INSTALLER_CLIENT = Object.freeze({
  'claude-code': 'claude-code',
  'claude-desktop': 'claude-desktop',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini-cli',
  kiro: 'kiro',
  'qwen-code': 'qwen-code',
  opencode: 'opencode'
});
// FULI's integration details and the installer's components.
const INSTALLER_COMPONENT = Object.freeze({
  mcp: 'mcp', skills: 'skills', lifecycleHooks: 'hooks', hooks: 'hooks', bootstrap: 'instructions', plugin: 'plugin'
});
// How long one comparison stands before the next doctor read refreshes it.
const REFRESH_MS = 10 * 60_000;

// fuliClients: inspectAgentInstallations() results. installerClients: the
// installer's `status` clients. Only state codes leave here, never paths or
// the installer's messages.
function compareInstallations(fuliClients, installerClients) {
  const byId = new Map(installerClients.map((client) => [client.id, client]));
  return fuliClients.filter((client) => INSTALLER_CLIENT[client.id]).map((client) => {
    const installer = byId.get(INSTALLER_CLIENT[client.id]);
    // A component the installer calls unsupported is not part of that client
    // (FULI reports a client without Skill folders as having current Skills).
    const installerComponents = Object.fromEntries((installer?.componentStates ?? [])
      .map(({ component, state }) => [component, state]));
    const components = Object.entries(client.integrationDetails ?? {})
      .filter(([detail]) => INSTALLER_COMPONENT[detail] && installerComponents[INSTALLER_COMPONENT[detail]] !== 'unsupported')
      .map(([detail, fuli]) => ({ component: INSTALLER_COMPONENT[detail], fuli,
        installer: installerComponents[INSTALLER_COMPONENT[detail]] ?? null }))
      .filter(({ fuli, installer: state }) => fuli !== state);
    return { id: client.id, installerId: INSTALLER_CLIENT[client.id], fuli: client.integrationStatus,
      installer: installer?.state ?? null, agree: client.integrationStatus === installer?.state, components };
  });
}

// One comparison: FULI's expected integration (the client observation
// context) written as the installer's manifest, the installer's `status`
// for it, and FULI's own inspection of the same clients.
export async function runInstallerShadow({ installer, manifestPath, context, discover, inspect }) {
  writeDerivedJson(manifestPath, fuliInstallerManifest());
  const answer = await installer.status(installerVariables(context));
  if (answer.status !== 'available') return answer;
  const agents = discover({ includeUnavailable: true, dataDir: context.dataDir });
  return { status: 'available', clients: compareInstallations(inspect(agents, context), answer.clients) };
}

// run: resolves { status: 'available', clients } (compared clients) or
// { status: 'unavailable', reason }. The doctor never waits for it: `latest`
// answers the last comparison and starts a new one when it is stale.
export function createInstallerShadow({ run, now = Date.now }) {
  let latest = { status: 'pending' };
  let checkedAt = null;
  let running = null;
  return {
    latest() {
      if (!running && (checkedAt === null || now() - checkedAt >= REFRESH_MS)) {
        running = Promise.resolve().then(run)
          .catch((error) => ({ status: 'unavailable', reason: error.message }))
          .then((result) => {
            latest = { ...result, checkedAt: new Date(now()).toISOString() };
            checkedAt = now();
            running = null;
            return latest;
          });
      }
      return latest;
    }
  };
}
