import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { isMainModule } from '../system/main-module.js';
import { runTrayAction } from './desktop-controller.js';
import { readWindowsInstallation } from './windows-installation-context.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function contains(root, path) {
  const local = relative(root, path);
  return !isAbsolute(local) && local.split(/[\\/]/)[0] !== '..';
}

// Resolve existing ancestors too, so junction/case aliases share one tray lock
// even before a new data directory has been created. This never creates data.
function canonicalPath(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error('Cannot resolve the selected directory.');
  return resolve(canonicalPath(parent), relative(parent, absolute));
}

export function validateTrayDataDir(packageRoot, dataDir, env = process.env) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) {
    throw new Error('The tray candidate requires an explicit absolute dataDir.');
  }
  const root = canonicalPath(packageRoot);
  const data = canonicalPath(dataDir);
  if (contains(root, data) || contains(data, root)) {
    throw new Error('The tray candidate data directory must be outside its application directory.');
  }
  const knownDaily = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Fuli'), env.FULI_DATA_DIR].filter(Boolean);
  for (const path of knownDaily) {
    const daily = canonicalPath(path);
    if (contains(daily, data) || contains(data, daily)) {
      throw new Error('The tray candidate must not use the daily Fuli data directory.');
    }
  }
  return data;
}

export function loadTrayContext({ packageRoot = PACKAGE_ROOT, env = process.env } = {}) {
  const root = canonicalPath(packageRoot);
  if (!readWindowsNativeBundle(root)) throw new Error('The tray requires a complete Windows portable bundle.');
  const config = JSON.parse(readFileSync(join(root, 'tray-config.json'), 'utf8'));
  if (config.version !== 1 || config.kind !== 'windows-tray-candidate') {
    throw new Error('The tray candidate configuration is not supported.');
  }
  const installed = readWindowsInstallation(root);
  const dataDir = installed?.dataDir ?? validateTrayDataDir(root, config.dataDir, env);
  return { packageRoot: root, dataDir,
    instanceKey: createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 32),
    nodePath: join(root, 'runtime', 'node', 'node.exe'), cliPath: join(root, 'src', 'cli.js'),
    logDir: join(dataDir, 'logs'), nativeLogDir: join(dataDir, 'native-runtime', 'personal', 'logs') };
}

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected exactly one tray action.');
    const context = loadTrayContext();
    const result = process.argv[2] === 'context'
      ? { ok: true, dataDir: context.dataDir, logDir: context.logDir,
        nativeLogDir: context.nativeLogDir, instanceKey: context.instanceKey }
      : await runTrayAction(process.argv[2], context);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, status: 'unknown', error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
