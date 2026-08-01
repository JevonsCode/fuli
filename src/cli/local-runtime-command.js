import {
  inspectLocalRuntime,
  openLocalConsole,
  restartLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime
} from '../local-runtime/lifecycle.js';
import { resolveSetupPaths } from '../setup/paths.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  readRuntimeSettings,
  runtimeSettingsWithOverrides
} from '../system/runtime-settings.js';
import { parseLocalRuntimeOptions } from './local-runtime-options.js';

export async function runLocalRuntimeCommand(command, args, dependencies = {}) {
  const options = parseLocalRuntimeOptions(command, args);
  const resolvePaths = dependencies.resolvePaths ?? resolveSetupPaths;
  const env = dependencies.env ?? process.env;
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const readSettings = dependencies.readSettings ?? readRuntimeSettings;
  const savedSettings = paths.runtimeSettingsPath
    ? readSettings(paths.runtimeSettingsPath)
    : DEFAULT_RUNTIME_SETTINGS;
  const runtimeSettings = runtimeSettingsWithOverrides(savedSettings, {
    consolePort: options.port,
    lanAccess: options.lan
  });
  const write = dependencies.write ?? writeLine;
  const input = {
    ...options,
    port: runtimeSettings.ports.console,
    lan: runtimeSettings.lanAccess,
    runtimeSettings,
    paths,
    env,
    onProgress: write
  };
  const handlers = {
    start: dependencies.start ?? startLocalRuntime,
    stop: dependencies.stop ?? stopLocalRuntime,
    restart: dependencies.restart ?? restartLocalRuntime,
    status: dependencies.inspect ?? inspectLocalRuntime,
    open: dependencies.openConsole ?? openLocalConsole
  };
  const result = await handlers[command](input, dependencies.lifecycleDependencies);

  if (command === 'status' && options.json) {
    write(JSON.stringify(result, null, 2));
  } else {
    write(formatLocalRuntimeResult(command, result));
  }
  return {
    ...result,
    exitCode: command === 'status' && result.status !== 'running'
      ? 1
      : result.status === 'partial' ? 1 : 0
  };
}

export function formatLocalRuntimeResult(command, result) {
  if (command === 'start') {
    const title = result.status === 'running'
      ? 'Fuli local services are already running.'
      : 'Fuli local services started.';
    return formatStartedRuntime(title, result);
  }
  if (command === 'restart') {
    return formatStartedRuntime('Fuli local services restarted.', result);
  }
  if (command === 'stop') {
    if (result.status === 'partial') {
      return [
        'The local Fuli Provider stopped, but the unverified UI process was left running.',
        'Run fl status to inspect it without risking another process.'
      ].join('\n');
    }
    return result.console === 'not_running' && result.providers === 'not_initialized'
      ? 'Fuli local services have not been initialized.'
      : 'Fuli local services stopped. Graph data was preserved.';
  }
  if (command === 'open') return `Opened: ${result.url}`;
  if (command === 'status') return formatStatus(result);
  throw new TypeError(`Unknown local runtime command: ${command}`);
}

function formatStartedRuntime(title, result) {
  const lines = [title, `Management UI: ${result.url}`];
  if (result.lan === true) {
    lines.push(
      'LAN URLs:',
      ...result.lanUrls.map((url) => `  ${url}`),
      `Username: ${result.lanAccess.username}`,
      `Temporary access code: ${result.lanAccess.accessCode}`,
      'Use only on trusted Wi-Fi. Restarting LAN mode rotates the access code.'
    );
  }
  return lines.join('\n');
}

function formatStatus(result) {
  const labels = {
    running: 'running',
    degraded: 'degraded',
    stopped: 'stopped',
    not_configured: 'not initialized',
    ready: 'ready',
    unavailable: 'unavailable',
    not_connected: 'not connected',
    not_configured_provider: 'not configured',
    unverified: 'identity unverified'
  };
  const publicSummary = result.public.configured
    ? `${labels[result.public.status] ?? result.public.status} (${result.public.providers.length} Providers)`
    : labels.not_connected;
  return [
    `Fuli local status: ${labels[result.status] ?? result.status}`,
    `Management UI: ${labels[result.console.status] ?? result.console.status} · ${result.console.url}`,
    `Personal graph: ${providerLabel(result.personal.status, labels)}`,
    `Shared services: ${publicSummary}`
  ].join('\n');
}

function providerLabel(status, labels) {
  if (status === 'not_configured') return labels.not_configured_provider;
  return labels[status] ?? status;
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
