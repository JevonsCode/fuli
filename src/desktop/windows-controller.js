import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { switchConsolePort } from '../system/console-port-switch.js';
import { isMainModule } from '../system/main-module.js';
import { reservedPortProblem } from '../system/reserved-ports.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { readWindowsInstallation, windowsMigrationCommand } from './windows-installation-context.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ACTIONS = new Set(['status', 'start', 'start-open', 'open', 'stop', 'change-port']);
const STATES = new Set(['running', 'stopped', 'degraded', 'not_configured']);

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

export function trayStateLabel(state) {
  if (state.status === 'running') {
    if (['sleeping', 'provider-sleeping'].includes(state.adaptiveRuntime?.stage)) {
      return '按设置休眠 / Sleeping as configured';
    }
    return '运行中 / Running';
  }
  return { stopped: '已停止 / Stopped', not_configured: '尚未配置 / Not configured',
    degraded: '服务不完整 / Degraded' }[state.status] ?? '状态未知 / Unknown';
}

function assertNativeSelection(context) {
  const path = join(context.dataDir, 'runtime-settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if ((settings && settings.graphRuntimeMode !== 'native') || (!settings
      && existsSync(join(context.dataDir, 'graph-runtime.json')))) {
    throw new Error('The selected data is not configured for native mode. The tray will not switch its runtime mode. '
      + '已有数据仍使用 Docker；先迁移到内置数据库 / Move it to the built-in database first: ' + windowsMigrationCommand(context.packageRoot));
  }
}

// Whether the selected data's console port is one Windows will not hand out.
async function consolePortBlocked(context) {
  const settings = readRuntimeSettings(join(context.dataDir, 'runtime-settings.json'));
  return await reservedPortProblem(settings.ports.console, {
    host: settings.lanAccess ? '0.0.0.0' : '127.0.0.1' }) !== null;
}

export async function runTrayAction(action, context, {
  runCli = executeCli, portBlocked = consolePortBlocked, switchPort = switchConsolePort
} = {}) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported tray action: ' + action);
  const invoke = (args) => runCli(context, [...args, '--data-dir', context.dataDir]);
  const inspect = async () => {
    const result = await invoke(['status', '--json']);
    if (![0, 1].includes(result.code)) throw cliError(result);
    let state;
    try { state = JSON.parse(result.stdout); }
    catch { throw new Error('Fuli status did not return valid JSON.'); }
    if (!STATES.has(state?.status)) throw new Error('Fuli status returned an unknown state.');
    return state;
  };
  const command = async (args) => {
    const result = await invoke(args);
    if (result.code !== 0) throw cliError(result);
  };
  let starting = false;
  let notice = null;
  try {
    if (['start', 'start-open', 'stop', 'change-port'].includes(action)) assertNativeSelection(context);
    if (action === 'change-port') {
      if (!existsSync(join(context.dataDir, 'graph-runtime.json'))) {
        throw new Error('Fuli 尚未设置，请先「启动并打开」。 / Fuli is not set up yet; use Start and open first.');
      }
      const before = await inspect();
      const switched = await switchPort(resolveSetupPaths({ dataDir: context.dataDir }));
      // Client MCP and hook configurations name the data directory, never a port;
      // a running MCP process keeps the console address it read when it started.
      notice = `已改用端口 ${switched.port}（原 ${switched.previousPort}）。已打开的 Agent 会话里的 Fuli 链接仍指向旧地址，重开会话即可更新。`
        + ` / Fuli now uses port ${switched.port} (was ${switched.previousPort}). Fuli links in open Agent sessions point to the old address until those sessions restart.`;
      await command([before.status === 'running' ? 'restart' : 'start']);
      const ready = await inspect();
      if (ready.status !== 'running') throw new Error('Fuli did not reach its running state.');
    }
    if (action === 'start' || action === 'start-open') {
      starting = true;
      if (!existsSync(join(context.dataDir, 'graph-runtime.json'))) {
        await command(['setup', '--yes', '--skip-agents', '--personal-only', '--runtime-mode', 'native']);
      } else {
        const before = await inspect();
        if (before.status !== 'running') await command(['start']);
      }
      const ready = await inspect();
      if (ready.status !== 'running') throw new Error('Fuli did not reach its running state.');
    }
    if (['open', 'start-open', 'change-port'].includes(action)) await command(['open']);
    if (action === 'stop') await command(['stop']);
    const state = await inspect();
    if (action === 'stop' && !['stopped', 'not_configured'].includes(state.status)) {
      throw new Error('Fuli did not confirm that the selected runtime stopped.');
    }
    return { ok: true, action, status: state.status, label: trayStateLabel(state), state, ...(notice ? { notice } : {}) };
  } catch (error) {
    // A failed start can already own processes. Keep their CLI state and report
    // what is actually running; never kill by process name or delete the data.
    const state = await inspect().catch(() => null);
    // A start that failed on a port Windows reserves offers the port change.
    const blocked = starting && await portBlocked(context).catch(() => false);
    return { ok: false, action, status: state?.status ?? 'unknown',
      label: state ? trayStateLabel(state) : '状态未知 / Unknown',
      state, error: notice ? `${error.message}\n\n${notice}` : error.message,
      ...(blocked ? { portBlocked: true } : {}) };
  }
}

function cliError(result) {
  // CLI error details are written to stderr. Do not copy setup/start stdout:
  // LAN output can contain a temporary access code.
  return new Error(String(result.stderr ?? '').trim().slice(-4000)
    || 'The selected Fuli CLI failed (exit ' + result.code + '). See its log directories.');
}

function executeCli(context, args) {
  return new Promise((resolveRun) => {
    execFile(context.nodePath, [context.cliPath, ...args], {
      cwd: context.packageRoot, env: process.env, windowsHide: true,
      encoding: 'utf8', timeout: 300_000, maxBuffer: 4 * 1024 * 1024
    }, (error, stdout, stderr) => resolveRun({ code: error ? error.code ?? 1 : 0, stdout,
      stderr: stderr || (error && typeof error.code !== 'number' ? error.message : '') }));
  });
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
