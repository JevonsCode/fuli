import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMacosNativeBundle } from '../native-runtime/macos-assets.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { isMainModule } from '../system/main-module.js';
import { runTrayAction } from './desktop-controller.js';

// The macOS app's entry for its desktop client
// (desktop/flutter/lib/src/runtime/macos_app_runtime.dart):
// `<package>/runtime/node/bin/node src/desktop/macos-controller.js <action>`
// inside FULI.app/Contents/Resources/fuli, printing one JSON line. The data
// directory is the one FULI uses on macOS anyway (src/setup/paths.js), so the
// app and an npm installation of the same person share it; nothing is moved.

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadMacosAppContext({ packageRoot = PACKAGE_ROOT, env = process.env } = {}) {
  const root = realpathSync(packageRoot);
  if (!readMacosNativeBundle(root)) throw new Error('The FULI app is missing its bundled runtime (native-bundle.json).');
  const { dataDir } = resolveSetupPaths({ env, packageRoot: root, platform: 'darwin' });
  return { packageRoot: root, dataDir,
    nodePath: join(root, 'runtime', 'node', 'bin', 'node'), cliPath: join(root, 'src', 'cli.js') };
}

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected exactly one action.');
    const result = await runTrayAction(process.argv[2], loadMacosAppContext());
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, status: 'unknown', error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
