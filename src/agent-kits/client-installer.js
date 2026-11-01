import { createInstaller, defaultExtensionsDirectory } from './vendor/agent-installer/index.mjs';
import { prepareInstallerManifest } from './installer-manifest.js';

const COMPONENT = 'agent-installer';
// `status` only reads client configuration; a slow disk still answers well within this.
const STATUS_TIMEOUT_MS = 30_000;

// FULI's port to agent-installer (rec#11 D-79). It answers which agent
// clients are on this machine and whether FULI is in each, from FULI's
// product manifest; FULI's own writers still install, so `apply` and `remove`
// are deliberately not reachable from here. `status` answers
// { status: 'available', clients, extensionErrors } or { status: 'unavailable', reason }.
//
// manifestPath: where FULI's product manifest is composed (installer-manifest.js).
// context: what setup installs (integration-context.js). targets: FULI's
// writer targets (agentTargets), read for OpenCode's version.
// extensionsDir: the shared extension directory, where custom clients are described.
export function createClientInstallerPort({ executables, manifestPath, context, targets,
  extensionsDir = defaultExtensionsDirectory() }) {
  return {
    extensionsDir,
    async status() {
      const executable = await executables.ensure(COMPONENT);
      if (executable.status !== 'available') return executable;
      try {
        const variables = prepareInstallerManifest({ manifestPath, context, targets: targets() });
        const installer = createInstaller({ executable: executable.path, manifestPath, variables,
          timeoutMs: STATUS_TIMEOUT_MS, ...(extensionsDir ? { extensionsDir } : {}) });
        const { clients, extensionErrors } = await installer.status();
        return { status: 'available', clients, extensionErrors };
      } catch (error) {
        return { status: 'unavailable', reason: `${error?.code ?? 'internal_error'}: ${error?.message}` };
      }
    }
  };
}
