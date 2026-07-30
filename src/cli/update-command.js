import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  FULI_PACKAGE_NAME,
  FULI_VERSION
} from '../package-metadata.js';
import { quoteShellArgument } from '../runtime-options.js';
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
    write('已取消，没有修改任何内容。');
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
      '无法安全确认旧版界面进程已停止，更新尚未开始。',
      '请先运行 fuli status 检查本地状态，再重试 fuli update。'
    ].join('\n'));
  }

  const selectedPackage = `${FULI_PACKAGE_NAME}@${latestVersion}`;
  write(`正在安装 ${selectedPackage}（npm latest）…`);
  const installed = runInherited(npmCommand, [
    'install',
    '--global',
    selectedPackage,
    '--no-audit',
    '--no-fund'
  ], { env });
  if (!processSucceeded(installed)) {
    throw new Error([
      `全局包安装失败（${describeProcessFailure(installed)}）。知识数据未删除。`,
      `请先运行 npm install --global ${LATEST_PACKAGE}，再运行 fuli setup --yes。`
    ].join('\n'));
  }

  const globalRootResult = runCaptured(npmCommand, ['root', '--global'], { env });
  if (!processSucceeded(globalRootResult)) {
    throw postInstallError(
      `无法定位 npm 全局安装目录（${describeProcessFailure(globalRootResult)}）`,
      args,
      platform
    );
  }
  const globalRoot = String(globalRootResult.stdout ?? '').trim();
  const cliPath = resolveGlobalCliPath(globalRoot, platform);
  if (!cliPath || !fileExists(cliPath)) {
    throw postInstallError('新版 CLI 文件不存在，请重新安装全局包', args, platform);
  }

  const versionResult = runCaptured(nodePath, [cliPath, '--version'], { env });
  if (!processSucceeded(versionResult)) {
    throw postInstallError(
      `新版 CLI 无法启动（${describeProcessFailure(versionResult)}）`,
      args,
      platform
    );
  }
  const version = String(versionResult.stdout ?? '').trim();
  if (!version) throw postInstallError('新版 CLI 未返回版本号', args, platform);
  if (compareSemanticVersions(version, latestVersion) !== 0) {
    throw postInstallError(
      `新版 CLI 版本 ${version} 与更新前确认的 npm latest ${latestVersion} 不一致`,
      args,
      platform
    );
  }

  write('正在使用新版 CLI 刷新本机服务、Agent 接入和 Skills…');
  const setupArgs = ['setup', '--yes', ...args.filter((arg) => arg !== '--yes')];
  const setupResult = runInherited(nodePath, [cliPath, ...setupArgs], { env });
  if (!processSucceeded(setupResult)) {
    throw postInstallError(
      `新版已安装，但 setup 未完成（${describeProcessFailure(setupResult)}）`,
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
    '准备更新复利',
    `npm 包：${LATEST_PACKAGE}`,
    options.noStart
      ? '本地界面：安全停止；更新后保持关闭'
      : '本地服务：安全停止；更新后由新版重新启动',
    options.dataDir ? `数据：保留 ${options.dataDir}` : '数据：保留当前默认数据目录',
    `Agent 接入与 Skills：${options.skipAgents ? '按参数跳过刷新' : '由新版 setup 刷新'}`
  ].join('\n');
}

export function formatUpdateResult(result) {
  if (result.status === 'ahead') {
    return [
      `当前 CLI 版本 ${result.version} 高于 npm latest ${result.latestVersion}；`,
      '为避免降级，未停止服务、未安装包，也未修改 Agent 接入。'
    ].join('');
  }
  if (result.status === 'current') {
    return `复利已是最新版本 ${result.version}；本机接入已刷新。`;
  }
  return `复利已从 ${result.previousVersion} 更新到 ${result.version}。`;
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
    `${message}。知识数据未删除。`,
    `请重新运行：${formatSetupRecoveryCommand(args, platform)}`
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
      `无法检查 ${LATEST_PACKAGE}（${describeProcessFailure(result)}）。`,
      '本地服务尚未停止，也没有安装或修改任何包。'
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
    return '<复用原参数>';
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
    const answer = (await input.question('将修改全局 npm 安装，继续？[Y/n] '))
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
