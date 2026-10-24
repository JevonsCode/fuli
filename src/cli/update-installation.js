import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FULI_PACKAGE_NAME, FULI_VERSION } from '../package-metadata.js';
import { platformPath } from '../system/platform-path.js';

export function updateEnvironment(env, nodePath, platform = process.platform) {
  const path = platformPath(platform);
  const key = platform === 'win32'
    ? Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
    : 'PATH';
  return { ...env, [key]: [path.dirname(nodePath), env[key]].filter(Boolean).join(path.delimiter) };
}

export function inspectUpdateInstallation({ env = process.env, platform = process.platform } = {}) {
  const path = platformPath(platform);
  const pathKey = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const directories = [...new Set((env[pathKey] ?? '').split(path.delimiter).filter(Boolean))];
  const launchers = [];
  for (const directory of directories) {
    for (const name of platform === 'win32' ? ['fl.cmd', 'fuli.cmd', 'fl', 'fuli'] : ['fl', 'fuli']) {
      const launcher = path.join(directory, name);
      if (!existsSync(launcher)) continue;
      let version = null;
      let target = launcher;
      try {
        target = realpathSync(launcher);
        // Read only the manifest for a recognized Fuli entry point; never execute PATH candidates.
        if (path.basename(target) === 'cli.js' && path.basename(path.dirname(target)) === 'src') {
          const manifest = JSON.parse(readFileSync(path.join(path.dirname(target), '..', 'package.json'), 'utf8'));
          if (manifest.name === FULI_PACKAGE_NAME) version = manifest.version;
        }
      } catch { /* Broken or unreadable candidates remain visible with an unknown version. */ }
      launchers.push({ path: launcher, target, version });
    }
  }
  return { cliPath: fileURLToPath(new URL('../cli.js', import.meta.url)), launchers };
}

// A shell running a bare `fl`/`fuli` takes the first launcher on PATH. When that is a
// different Fuli installation, the command keeps answering with the old version even
// though this one was installed and set up (rec#41). Client hooks and MCP are written
// with absolute paths, so only bare shell commands are affected.
export function formatShadowedLaunchers(installation, { target = installation.cliPath, platform = process.platform } = {}) {
  const path = platformPath(platform);
  let realTarget = target;
  try { realTarget = realpathSync(target); } catch { /* compare the path as given */ }
  const own = installation.launchers.find((launcher) => launcher.target === realTarget);
  const shadowing = [];
  for (const command of ['fl', 'fuli']) {
    const first = installation.launchers.find((launcher) =>
      path.basename(launcher.path).replace(/\.cmd$/i, '') === command);
    // Only a recognized Fuli installation is reported; an unknown wrapper is never guessed at.
    if (first?.version && first.target !== realTarget) shadowing.push({ command, ...first });
  }
  if (!shadowing.length) return null;
  // An npm global package lives at <prefix>/lib/node_modules/<name>/src/cli.js.
  const nodeModules = path.dirname(path.dirname(path.dirname(shadowing[0].target)));
  const lib = path.dirname(nodeModules);
  const fix = path.basename(nodeModules) === 'node_modules' && path.basename(lib) === 'lib'
    ? `npm uninstall --global ${FULI_PACKAGE_NAME} --prefix ${path.dirname(lib)}`
    : 'remove that installation';
  return [
    ...shadowing.map(({ command, path: launcher, version, target: other }) =>
      `Warning: \`${command}\` on PATH is another Fuli installation: ${launcher} -> ${version} (${other}).`),
    'Shells that run the bare command get that version; client hooks and MCP use absolute paths and are not affected.',
    `To fix: ${fix}${own ? `, or put ${path.dirname(own.path)} first in PATH` : ''}.`
  ].join('\n');
}

export function formatUpdateInstallation(installation, { nodePath, npmCommand }) {
  const groups = new Map();
  for (const launcher of installation.launchers) {
    const group = groups.get(launcher.target) ?? { paths: [], version: launcher.version };
    group.paths.push(launcher.path);
    groups.set(launcher.target, group);
  }
  return [
    `Running Fuli: ${FULI_VERSION} (${installation.cliPath})`,
    `Node: ${nodePath}`,
    `npm: ${npmCommand} (current Node directory first in PATH)`,
    ...[...groups].map(([target, { paths, version }]) =>
      `PATH launchers: ${paths.join(', ')} -> ${target} (${version ?? 'version unknown; wrapper not executed'})`),
    'If a PATH launcher belongs to another installation, it will keep its own version.'
  ].join('\n');
}
