import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FULI_PACKAGE_NAME,
  FULI_VERSION
} from '../package-metadata.js';
import { quoteShellArgument } from './shell-argument.js';
import { parseUpdateOptions } from '../setup/options.js';
import { runLocalRuntimeCommand } from './local-runtime-command.js';
import {
  formatShadowedLaunchers,
  formatUpdateInstallation,
  inspectUpdateInstallation,
  updateEnvironment
} from './update-installation.js';
import { readWindowsInstallation } from '../desktop/windows-installation-context.js';
import { readMacosNativeBundle } from '../native-runtime/macos-assets.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { confirmInTerminal, writeLine } from './terminal-io.js';
import { platformPath } from '../system/platform-path.js';
import { channelVersion } from '../system/package-version-checker.js';

export { compareSemanticVersions } from '../semantic-version.js';


export async function runUpdateCommand(args = [], dependencies = {}) {
  const options = parseUpdateOptions(args);
  const platform = dependencies.platform ?? process.platform;
  const packageRoot = dependencies.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (platform === 'win32' && readWindowsInstallation(packageRoot)) {
    throw new Error('The npm update command is not supported for a Windows per-user installation. Exit the Fuli tray, then run Update-Fuli.cmd from the newer verified candidate; use --preview to inspect it first. Keep the application and data directories.');
  }
  if (platform === 'darwin' && readMacosNativeBundle(packageRoot)) {
    throw new Error('The FULI app is updated by replacing it, not through npm. Quit FULI, open the newer FULI .dmg and drag FULI.app to Applications again; the data directory stays where it is.');
  }
  const nodePath = dependencies.nodePath ?? process.execPath;
  const originalEnv = dependencies.env ?? process.env;
  const env = updateEnvironment(originalEnv, nodePath, platform);
  const npmCommand = dependencies.npmCommand ??
    (platform === 'win32' ? 'npm.cmd' : 'npm');
  const confirm = dependencies.confirm
    ?? (() => confirmInTerminal('This will modify the global npm installation. Continue? [Y/n] ', { defaultYes: true }));
  const write = dependencies.write ?? writeLine;
  const stopRuntime = dependencies.stopRuntime ?? runLocalRuntimeCommand;
  const runInherited = dependencies.runInherited ?? spawnInherited;
  const runCaptured = dependencies.runCaptured ?? spawnCaptured;
  const fileExists = dependencies.fileExists ?? existsSync;
  const channel = options.beta ? 'beta' : 'stable';
  const resolveLatestVersion = dependencies.resolveLatestVersion ??
    (() => queryLatestVersion(npmCommand, runCaptured, env, channel));

  write(formatUpdatePreview(options));
  const inspectInstallation = dependencies.inspectInstallation ?? inspectUpdateInstallation;
  const installation = inspectInstallation({ env: originalEnv, platform });
  write(formatUpdateInstallation(installation, { nodePath, npmCommand }));
  // Judged on the person's own PATH, not the update's, which puts this Node first.
  const writeShadowed = (inspected, target = inspected.cliPath) => {
    const shadowed = formatShadowedLaunchers(inspected, { target, platform });
    if (shadowed) write(shadowed);
  };
  const latestVersion = resolveLatestVersion();
  const comparison = compareSemanticVersions(latestVersion, FULI_VERSION);
  if (comparison === 0) {
    const result = { status: 'current', previousVersion: FULI_VERSION, version: FULI_VERSION };
    write(formatUpdateResult(result));
    writeShadowed(installation);
    return result;
  }
  if (comparison < 0) {
    const result = {
      status: 'ahead',
      previousVersion: FULI_VERSION,
      version: FULI_VERSION,
      latestVersion
    };
    write(formatUpdateResult(result));
    writeShadowed(installation);
    return result;
  }

  const globalRootResult = runCaptured(npmCommand, ['root', '--global'], { env });
  if (!processSucceeded(globalRootResult)) {
    throw new Error(`Could not locate the npm installation target (${describeProcessFailure(globalRootResult)}). Local services were not stopped.`);
  }
  const globalRoot = String(globalRootResult.stdout ?? '').trim();
  const cliPath = resolveGlobalCliPath(globalRoot, platform);
  if (!cliPath) throw new Error('npm returned an invalid global directory. Local services were not stopped.');
  const recoveryCommand = formatSetupRecoveryCommand(args, platform, [nodePath, cliPath]);
  write(`Update target: ${cliPath}`);
  if (installation.cliPath && installation.cliPath !== cliPath) {
    write('The running CLI path differs from the npm target. This command updates the npm target above.');
  }
  if (!options.yes && !await confirm()) {
    write('Cancelled. No changes were made.');
    return { status: 'cancelled' };
  }
  const stopArgs = options.dataDir ? ['--data-dir', options.dataDir] : [];
  const stopped = await stopRuntime('stop', stopArgs, { env, write });
  if (stopped.status === 'partial') {
    throw new Error([
      'Could not safely confirm that the previous UI process stopped. The update did not start.',
      'Run fuli status to inspect the local state, then retry fuli update.'
    ].join('\n'));
  }

  const selectedPackage = `${FULI_PACKAGE_NAME}@${latestVersion}`;
  write(`Installing ${selectedPackage} (npm ${channel === 'beta' ? 'beta channel' : 'latest'})...`);
  const installed = runInherited(npmCommand, [
    'install',
    '--global',
    selectedPackage,
    '--no-audit',
    '--no-fund'
  ], { env });
  if (!processSucceeded(installed)) {
    throw new Error([
      `Global package installation failed (${describeProcessFailure(installed)}). ` +
        'Knowledge data was not deleted.',
      'Local services were stopped and have not been restarted.',
      `Run npm install --global ${selectedPackage}, then run ${recoveryCommand}.`
    ].join('\n'));
  }

  if (!fileExists(cliPath)) {
    throw postInstallError('The new CLI file is missing; reinstall the global package', recoveryCommand);
  }

  const versionResult = runCaptured(nodePath, [cliPath, '--version'], { env });
  if (!processSucceeded(versionResult)) {
    throw postInstallError(
      `The new CLI could not start (${describeProcessFailure(versionResult)})`,
      recoveryCommand
    );
  }
  const version = String(versionResult.stdout ?? '').trim();
  if (!version) throw postInstallError('The new CLI returned no version', recoveryCommand);
  if (compareSemanticVersions(version, latestVersion) !== 0) {
    throw postInstallError(
      `The new CLI version ${version} does not match the npm latest version ${latestVersion} ` +
        'confirmed before the update',
      recoveryCommand
    );
  }

  write('Refreshing local services, Agent integrations, and Skills with the new CLI...');
  const setupArgs = ['setup', '--yes', '--connected-only', ...args.filter((arg) =>
    arg !== '--yes' && arg !== '--connected-only')];
  const setupResult = runInherited(nodePath, [cliPath, ...setupArgs], { env });
  if (!processSucceeded(setupResult)) {
    throw postInstallError(
      `The new version was installed, but setup did not complete ` +
        `(${describeProcessFailure(setupResult)})`,
      recoveryCommand
    );
  }

  const result = {
    status: 'updated',
    previousVersion: FULI_VERSION,
    version
  };
  write(formatUpdateResult(result));
  writeShadowed(inspectInstallation({ env: originalEnv, platform }), cliPath);
  if (options.skipAgents) {
    write('Existing conversations may still use the previous MCP process. Reconnect Fuli in your client or restart the client, then open a new task. Running conversations were not restarted automatically.');
  }
  return result;
}

export function formatUpdatePreview(options) {
  return [
    'Ready to update Fuli',
    `npm package: ${FULI_PACKAGE_NAME}@${options.beta ? "beta channel (latest or beta, whichever is newer)" : "latest"}`,
    options.noStart
      ? 'If an upgrade is available: stop the local UI safely and keep it stopped'
      : 'If an upgrade is available: stop local services safely and restart with the new version',
    options.dataDir
      ? `Data: preserve ${options.dataDir}`
      : 'Data: preserve the current default data directory',
    `Neo4j memory: ${options.memoryProfile ?? 'keep saved profile or use balanced by default'}`,
    `Adaptive memory: ${options.adaptiveMemory === null
      ? 'keep saved setting'
      : options.adaptiveMemory ? 'enable' : 'disable'}`,
    `Agent integrations and Skills: ${options.skipAgents
      ? 'skip refresh as requested'
      : 'refresh through setup in the new version; only already connected clients'}`
  ].join('\n');
}

export function formatUpdateResult(result) {
  if (result.status === 'ahead') {
    return [
      `The current CLI version ${result.version} is newer than npm latest ${result.latestVersion}. `,
      'To avoid a downgrade, services were not stopped, no package was installed, and Agent ' +
        'integrations were not changed.'
    ].join('');
  }
  if (result.status === 'current') {
    return `Fuli is already at the latest version (${result.version}); no installation or service restart needed. To repair existing integrations, run fuli setup --yes --connected-only.`;
  }
  return `Fuli updated from ${result.previousVersion} to ${result.version}.`;
}

export function resolveGlobalCliPath(globalRoot, platform = process.platform) {
  const path = platformPath(platform);
  if (typeof globalRoot !== 'string' || !path.isAbsolute(globalRoot.trim())) return null;
  return path.join(globalRoot.trim(), FULI_PACKAGE_NAME, 'src', 'cli.js');
}

function postInstallError(message, recoveryCommand) {
  return new Error([
    `${message}. Knowledge data was not deleted.`,
    `Run again: ${recoveryCommand}`
  ].join('\n'));
}

// The newest release on the channel: npm's dist-tags, judged as the console's
// version check judges them (package-version-checker.js).
function queryLatestVersion(npmCommand, runCaptured, env, channel) {
  const result = runCaptured(
    npmCommand,
    ['view', FULI_PACKAGE_NAME, 'dist-tags', '--json'],
    { env }
  );
  if (!processSucceeded(result)) {
    throw new Error([
      `Could not check the ${FULI_PACKAGE_NAME} releases (${describeProcessFailure(result)}).`,
      'Local services were not stopped, and no package was installed or changed.'
    ].join('\n'));
  }
  return channelVersion(JSON.parse(String(result.stdout ?? '').trim()), channel);
}

function formatSetupRecoveryCommand(args, platform, launcher) {
  const forwarded = args
    .filter((arg) => arg !== '--yes' && arg !== '--connected-only')
    .map((arg) => formatCommandArgument(arg, platform));
  return [...launcher.map((arg) => formatCommandArgument(arg, platform)),
    'setup', '--yes', '--connected-only', ...forwarded].join(' ');
}

function formatCommandArgument(value, platform) {
  const simple = platform === 'win32'
    ? /^[A-Za-z0-9_./\\:@+-]+$/
    : /^[A-Za-z0-9_./:@+-]+$/;
  if (simple.test(value)) return value;
  try {
    return quoteShellArgument(value, platform);
  } catch {
    return '<reuse-original-argument>';
  }
}

function processSucceeded(result) {
  return result?.status === 0 && !result.error && !result.signal;
}

function describeProcessFailure(result) {
  if (result?.error?.message) return result.error.message;
  if (result?.signal) return `signal ${result.signal}`;
  if (Number.isInteger(result?.status)) return `exit code ${result.status}`;
  return 'unknown process error';
}

// Node refuses to spawn Windows batch files such as npm.cmd without a shell
// (CVE-2024-27980). Only fixed, shell-inert arguments may take that path.
export function batchFileSpawnOptions(command, args) {
  if (!/\.(?:cmd|bat)$/i.test(command)) return {};
  const unsafe = args.find((arg) => !/^[\w@./:=+-]+$/.test(arg));
  if (unsafe !== undefined) throw new TypeError(`Refusing to pass a shell-sensitive argument to ${command}`);
  return { shell: true };
}

function spawnInherited(command, args, { env }) {
  return spawnSync(command, args, {
    env,
    stdio: 'inherit',
    windowsHide: true,
    ...batchFileSpawnOptions(command, args)
  });
}

function spawnCaptured(command, args, { env }) {
  return spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...batchFileSpawnOptions(command, args)
  });
}
