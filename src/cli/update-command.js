import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  FULI_PACKAGE_NAME,
  FULI_VERSION
} from '../package-metadata.js';
import { quoteShellArgument } from './shell-argument.js';
import { parseUpdateOptions } from '../setup/options.js';
import { runLocalRuntimeCommand } from './local-runtime-command.js';

const LATEST_PACKAGE = `${FULI_PACKAGE_NAME}@latest`;

export async function runUpdateCommand(args = [], dependencies = {}) {
  const options = parseUpdateOptions(args);
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const nodePath = dependencies.nodePath ?? process.execPath;
  const npmCommand = dependencies.npmCommand ??
    (platform === 'win32' ? 'npm.cmd' : 'npm');
  const confirm = dependencies.confirm ?? confirmInTerminal;
  const write = dependencies.write ?? writeLine;
  const stopRuntime = dependencies.stopRuntime ?? runLocalRuntimeCommand;
  const runInherited = dependencies.runInherited ?? spawnInherited;
  const runCaptured = dependencies.runCaptured ?? spawnCaptured;
  const fileExists = dependencies.fileExists ?? existsSync;
  const resolveLatestVersion = dependencies.resolveLatestVersion ??
    (() => queryLatestVersion(npmCommand, runCaptured, env));

  write(formatUpdatePreview(options));
  if (!options.yes && !await confirm()) {
    write('Cancelled. No changes were made.');
    return { status: 'cancelled' };
  }

  const latestVersion = resolveLatestVersion();
  if (compareSemanticVersions(latestVersion, FULI_VERSION) < 0) {
    const result = {
      status: 'ahead',
      previousVersion: FULI_VERSION,
      version: FULI_VERSION,
      latestVersion
    };
    write(formatUpdateResult(result));
    return result;
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
  write(`Installing ${selectedPackage} (npm latest)...`);
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
      `Run npm install --global ${LATEST_PACKAGE}, then run fuli setup --yes.`
    ].join('\n'));
  }

  const globalRootResult = runCaptured(npmCommand, ['root', '--global'], { env });
  if (!processSucceeded(globalRootResult)) {
    throw postInstallError(
      `Could not locate the global npm directory (${describeProcessFailure(globalRootResult)})`,
      args,
      platform
    );
  }
  const globalRoot = String(globalRootResult.stdout ?? '').trim();
  const cliPath = resolveGlobalCliPath(globalRoot, platform);
  if (!cliPath || !fileExists(cliPath)) {
    throw postInstallError('The new CLI file is missing; reinstall the global package', args, platform);
  }

  const versionResult = runCaptured(nodePath, [cliPath, '--version'], { env });
  if (!processSucceeded(versionResult)) {
    throw postInstallError(
      `The new CLI could not start (${describeProcessFailure(versionResult)})`,
      args,
      platform
    );
  }
  const version = String(versionResult.stdout ?? '').trim();
  if (!version) throw postInstallError('The new CLI returned no version', args, platform);
  if (compareSemanticVersions(version, latestVersion) !== 0) {
    throw postInstallError(
      `The new CLI version ${version} does not match the npm latest version ${latestVersion} ` +
        'confirmed before the update',
      args,
      platform
    );
  }

  write('Refreshing local services, Agent integrations, and Skills with the new CLI...');
  const setupArgs = ['setup', '--yes', ...args.filter((arg) => arg !== '--yes')];
  const setupResult = runInherited(nodePath, [cliPath, ...setupArgs], { env });
  if (!processSucceeded(setupResult)) {
    throw postInstallError(
      `The new version was installed, but setup did not complete ` +
        `(${describeProcessFailure(setupResult)})`,
      args,
      platform
    );
  }

  const result = {
    status: version === FULI_VERSION ? 'current' : 'updated',
    previousVersion: FULI_VERSION,
    version
  };
  write(formatUpdateResult(result));
  return result;
}

export function formatUpdatePreview(options) {
  return [
    'Ready to update Fuli',
    `npm package: ${LATEST_PACKAGE}`,
    options.noStart
      ? 'Local UI: stop safely and keep stopped after the update'
      : 'Local services: stop safely and restart with the new version',
    options.dataDir
      ? `Data: preserve ${options.dataDir}`
      : 'Data: preserve the current default data directory',
    `Neo4j memory: ${options.memoryProfile ?? 'keep saved profile or use balanced by default'}`,
    `Adaptive memory: ${options.adaptiveMemory === null
      ? 'keep saved setting'
      : options.adaptiveMemory ? 'enable' : 'disable'}`,
    `Agent integrations and Skills: ${options.skipAgents
      ? 'skip refresh as requested'
      : 'refresh through setup in the new version'}`
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
    return `Fuli is already at the latest version (${result.version}); local integrations refreshed.`;
  }
  return `Fuli updated from ${result.previousVersion} to ${result.version}.`;
}

export function compareSemanticVersions(left, right) {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.core[index] > parsedRight.core[index]) return 1;
    if (parsedLeft.core[index] < parsedRight.core[index]) return -1;
  }
  if (!parsedLeft.prerelease.length && !parsedRight.prerelease.length) return 0;
  if (!parsedLeft.prerelease.length) return 1;
  if (!parsedRight.prerelease.length) return -1;
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function resolveGlobalCliPath(globalRoot, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  if (typeof globalRoot !== 'string' || !path.isAbsolute(globalRoot.trim())) return null;
  return path.join(globalRoot.trim(), FULI_PACKAGE_NAME, 'src', 'cli.js');
}

function postInstallError(message, args, platform) {
  return new Error([
    `${message}. Knowledge data was not deleted.`,
    `Run again: ${formatSetupRecoveryCommand(args, platform)}`
  ].join('\n'));
}

function queryLatestVersion(npmCommand, runCaptured, env) {
  const result = runCaptured(
    npmCommand,
    ['view', LATEST_PACKAGE, 'version', '--json'],
    { env }
  );
  if (!processSucceeded(result)) {
    throw new Error([
      `Could not check ${LATEST_PACKAGE} (${describeProcessFailure(result)}).`,
      'Local services were not stopped, and no package was installed or changed.'
    ].join('\n'));
  }
  const raw = String(result.stdout ?? '').trim();
  let version = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') version = parsed;
  } catch {
    // npm can also return one unquoted version line.
  }
  parseSemanticVersion(version);
  return version;
}

function parseSemanticVersion(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
    .exec(text);
  if (!match) throw new TypeError(`Invalid package version: ${text || '<empty>'}`);
  const numeric = match.slice(1, 4);
  if (numeric.some((part) => part.length > 1 && part.startsWith('0'))) {
    throw new TypeError(`Invalid package version: ${text}`);
  }
  return {
    core: numeric.map((part) => BigInt(part)),
    prerelease: match[4]?.split('.') ?? []
  };
}

function formatSetupRecoveryCommand(args, platform) {
  const forwarded = args
    .filter((arg) => arg !== '--yes')
    .map((arg) => formatCommandArgument(arg, platform));
  return ['fuli', 'setup', '--yes', ...forwarded].join(' ');
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

function spawnInherited(command, args, { env }) {
  return spawnSync(command, args, {
    env,
    stdio: 'inherit',
    windowsHide: true
  });
}

function spawnCaptured(command, args, { env }) {
  return spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

async function confirmInTerminal() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question('This will modify the global npm installation. Continue? [Y/n] '))
      .trim()
      .toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
