import { createInstaller } from './vendor/agent-installer/index.mjs';

const COMPONENT = 'agent-installer';
// `status` only reads client configuration; a slow disk still answers well within this.
const STATUS_TIMEOUT_MS = 30_000;

// FULI's port to agent-installer. In this stage it only reads `status`
// beside FULI's own inspection (installer-shadow.js); FULI's writers stay in
// charge, so `apply` and `remove` are deliberately not reachable from here
// (rec#11 D-79). Answers { status: 'available', clients } or
// { status: 'unavailable', reason }.
//
// manifestPath: FULI's composed product manifest (installer-manifest.js).
// extensionsDir: the shared extension directory; the binding's default when undefined.
export function createClientInstallerPort({ executables, manifestPath, extensionsDir }) {
  return {
    async status(variables) {
      const executable = await executables.ensure(COMPONENT);
      if (executable.status !== 'available') return executable;
      const installer = createInstaller({ executable: executable.path, manifestPath, variables,
        timeoutMs: STATUS_TIMEOUT_MS, ...(extensionsDir ? { extensionsDir } : {}) });
      try {
        return { status: 'available', clients: (await installer.status()).clients };
      } catch (error) {
        return { status: 'unavailable', reason: `${error?.code ?? 'internal_error'}: ${error?.message}` };
      }
    }
  };
}
