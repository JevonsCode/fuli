import { createInstaller, defaultExtensionsDirectory } from './vendor/agent-installer/index.mjs';
import { noteClientChanged } from '../mcp/process-registry.js';
import { clientSourceApplication } from './client-detection.js';
import { prepareInstallerManifest } from './installer-manifest.js';

const COMPONENT = 'agent-installer';
// `status` only reads client configuration; a slow disk still answers well within this.
const STATUS_TIMEOUT_MS = 30_000;
// A write also backs up each file and copies the Skills.
const WRITE_TIMEOUT_MS = 120_000;
// FULI's client IDs that agent-installer names differently, mapped in both
// directions here only: everything outside this port speaks FULI's IDs.
const INSTALLER_ID = Object.freeze({ gemini: 'gemini-cli' });
const FULI_ID = Object.freeze(Object.fromEntries(Object.entries(INSTALLER_ID).map(([fuli, installer]) => [installer, fuli])));
const toInstaller = (id) => INSTALLER_ID[id] ?? id;
const toFuli = (client) => ({ ...client, id: FULI_ID[client.id] ?? client.id });

// What the person reads when a write cannot reach agent-installer: FULI has
// no writer of its own to fall back on.
export const CLIENT_COMPONENT_UNAVAILABLE = '无法下载客户端组件 agent-installer，请检查网络后重试。'
  + ' The client component agent-installer could not be downloaded; check your network connection and try again.';

// FULI's port to agent-installer (rec#11 D-79, #11): the one place FULI
// reads and writes agent client configuration, from FULI's product manifest
// (installer-manifest.js). FULI has no writer of its own.
//
// status() answers { status: 'available', clients, extensionErrors }.
// plan(ids), apply(ids) and remove(ids) answer { status: 'available',
// clients, partial, problems, extensionErrors } (agent-installer's results);
// OpenCode's result carries `nextSteps` when it got no plugin. Each answers
// { status: 'unavailable', reason } when agent-installer cannot be had or
// started here; a write's other failures reject with the installer's `code`
// (`unknown_outcome`: never retry, read status first). plan and apply take
// `{ packs }` to write with descriptor packs that are not active yet (a pack
// update the person is still reviewing); otherwise the active packs are used.
// apply first retires FULI's legacy `mcp_tool` hooks in those clients.
//
// manifestPath: where the manifest is composed. context: this installation's
// paths (integration-context.js). backupsDir: where originals are copied
// before a change (setup paths' backupDir). openCode: answers whether
// OpenCode gets FULI's plugin (opencode-plugin-gate.js). retireLegacy(ids):
// legacy-hook-cleanup.js for these clients. extensionsDir: the shared
// extension directory, where custom clients are described. clientPrompts():
// the prompt files each client keeps now (installer-manifest.js).
export function createClientInstallerPort({ executables, manifestPath, context, backupsDir, openCode, retireLegacy,
  extensionsDir = defaultExtensionsDirectory(), clientPrompts = () => ({}) }) {
  async function installer(timeoutMs, packs) {
    const executable = await executables.ensure(COMPONENT);
    if (executable.status !== 'available') return { unavailable: executable.reason };
    const gate = openCode();
    const variables = prepareInstallerManifest({ manifestPath, context, openCodePlugin: gate.plugin, clientPrompts: clientPrompts(),
      ...(packs ? { packs } : {}) });
    return { gate, installer: createInstaller({ executable: executable.path, manifestPath, variables, timeoutMs,
      ...(backupsDir ? { backupsDir } : {}), ...(extensionsDir ? { extensionsDir } : {}) }) };
  }

  async function write(action, ids, packs) {
    const bound = await installer(WRITE_TIMEOUT_MS, packs);
    if (bound.unavailable) return unavailable(bound.unavailable);
    if (action === 'apply') retireLegacy(ids);
    let answer;
    try {
      answer = await bound.installer[action](ids.map(toInstaller));
    } catch (error) {
      if (error?.code === 'unavailable') return unavailable(error.message);
      throw error;
    }
    if (action === 'apply') noteChanged(answer.clients.map(toFuli), context.runtimeConfigPath);
    const nextSteps = bound.gate.nextStep && action !== 'remove' ? [bound.gate.nextStep] : [];
    return { status: 'available', partial: answer.partial, extensionErrors: answer.extensionErrors,
      problems: answer.problems.map(({ client, message }) => ({ client: FULI_ID[client] ?? client, message })),
      clients: answer.clients.map(toFuli).map((client) => (client.id === 'opencode' && nextSteps.length ? { ...client, nextSteps } : client)) };
  }

  return {
    extensionsDir,
    async status() {
      try {
        const bound = await installer(STATUS_TIMEOUT_MS);
        if (bound.unavailable) return unavailable(bound.unavailable);
        const { clients, extensionErrors } = await bound.installer.status();
        return { status: 'available', clients: clients.map(toFuli), extensionErrors };
      } catch (error) {
        return unavailable(`${error?.code ?? 'internal_error'}: ${error?.message}`);
      }
    },
    plan: (ids, { packs } = {}) => write('plan', ids, packs),
    apply: (ids, { packs } = {}) => write('apply', ids, packs),
    remove: (ids) => write('remove', ids)
  };
}

const unavailable = (reason) => ({ status: 'unavailable', reason });
const SESSION_FREE = new Set(['mcp', 'prompts']);

// Open sessions don't reread what this write changed; the MCP entry alone they
// don't need to, since the relay follows the installed version, and prompt
// files are read by the client's app, not its sessions.
export function noteChanged(clients, runtimeConfigPath) {
  for (const client of clients) {
    const source = clientSourceApplication(client.id);
    if (!source || !client.changes?.some(change => change.components?.some(component => !SESSION_FREE.has(component)))) continue;
    try { noteClientChanged(runtimeConfigPath, source); } catch { /* only the prompt is missing */ }
  }
}
