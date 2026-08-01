import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const DOCKER_INFO_ARGS = ['info', '--format', '{{.ServerVersion}}'];
const RANCHER_DOWNLOAD_URL = 'https://rancherdesktop.io/';
const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/';

export function inspectContainerRuntime({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  pathExists = existsSync,
  run = runProcess
} = {}) {
  const desktop = detectDesktopRuntime({ env, platform, homeDir, pathExists });
  const dockerCommand = resolveDockerCommand({ env, platform, homeDir, pathExists, run });
  if (!dockerCommand) {
    return {
      status: desktop ? 'stopped' : 'missing',
      label: desktop?.label ?? 'Docker',
      desktop,
      dockerCommand: null,
      dockerEnvironment: null,
      detail: 'docker command was not found'
    };
  }

  const dockerEnvironment = selectDockerEnvironment({
    env: dockerCommandEnvironment(dockerCommand, env, platform),
    platform,
    homeDir,
    socketExists: pathExists,
    dockerAvailable: (candidateEnvironment) => dockerInfoIndicatesDaemon(
      run(dockerCommand, DOCKER_INFO_ARGS, candidateEnvironment)
    )
  });
  const compose = run(dockerCommand, ['compose', 'version'], dockerEnvironment);
  if (!processSucceeded(compose)) {
    return {
      status: 'missing-compose',
      label: desktop?.label ?? 'Docker',
      desktop,
      dockerCommand,
      dockerEnvironment,
      detail: safeProcessDetail(compose, homeDir)
    };
  }

  const info = run(dockerCommand, DOCKER_INFO_ARGS, dockerEnvironment);
  if (dockerInfoIndicatesDaemon(info)) {
    return {
      status: 'ready',
      label: desktop?.label ?? 'Docker',
      desktop,
      dockerCommand,
      dockerEnvironment,
      detail: null
    };
  }

  const explicitTarget = nonEmpty(env.DOCKER_HOST) || nonEmpty(env.DOCKER_CONTEXT);
  return {
    status: desktop && !explicitTarget ? 'stopped' : 'unavailable',
    label: desktop?.label ?? 'Docker',
    desktop: explicitTarget ? null : desktop,
    dockerCommand,
    dockerEnvironment,
    detail: safeProcessDetail(info, homeDir),
    explicitTarget: Boolean(explicitTarget)
  };
}

export async function ensureContainerRuntime(options = {}, dependencies = {}) {
  const inspect = dependencies.inspect ?? inspectContainerRuntime;
  const launch = dependencies.launch ?? launchDesktopRuntime;
  const wait = dependencies.wait ?? delay;
  const onProgress = options.onProgress ?? (() => {});
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxWaitMs = options.maxWaitMs ?? 180_000;
  let runtime = inspect(options);

  if (runtime.status === 'ready') return runtime;
  if (runtime.status !== 'stopped' || !runtime.desktop) {
    throw containerRuntimeError(runtime, options.platform ?? process.platform);
  }

  onProgress(`Starting ${runtime.desktop.label}; the first launch may take a few minutes...`);
  await launch(runtime.desktop, dependencies);

  const attempts = Math.max(1, Math.ceil(maxWaitMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    runtime = inspect(options);
    if (runtime.status === 'ready') return runtime;
    if (runtime.status === 'missing-compose' || runtime.status === 'missing') {
      throw containerRuntimeError(runtime, options.platform ?? process.platform);
    }
    if (attempt < attempts - 1) await wait(pollIntervalMs);
  }

  throw new Error(
    `${runtime.desktop?.label ?? runtime.label} started, but the container engine was not ready ` +
    `within ${Math.ceil(maxWaitMs / 1000)} seconds. Open the application to inspect errors, ` +
    `confirm that docker info succeeds, then run fl setup again.${detailSuffix(runtime.detail)}`
  );
}

export function runDockerCompose(args, runtime = null, {
  platform = process.platform,
  homeDir = homedir(),
  run = runProcess
} = {}) {
  const resolved = runtime ?? inspectContainerRuntime({ platform, homeDir, run });
  if (resolved.status !== 'ready') {
    throw containerRuntimeError(resolved, platform);
  }
  const result = run(
    resolved.dockerCommand,
    args,
    resolved.dockerEnvironment
  );
  if (processSucceeded(result)) return;

  const detail = safeProcessDetail(result, homeDir);
  if (/port is already allocated|address already in use|bind.+failed/i.test(detail)) {
    throw new Error(`A local port required by Fuli is already in use.${detailSuffix(detail)}`);
  }
  if (/cannot connect|connection refused|error during connect|docker daemon|\bEOF\b/i.test(detail)) {
    throw new Error(
      `The container runtime disconnected while starting the Fuli Provider.${detailSuffix(detail)}`
    );
  }
  throw new Error(`Docker Compose could not start the Fuli Provider.${detailSuffix(detail)}`);
}

export function selectDockerEnvironment({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  dockerAvailable = defaultDockerAvailable,
  socketExists = existsSync
} = {}) {
  const selected = { ...env };
  if (nonEmpty(env.DOCKER_HOST) || nonEmpty(env.DOCKER_CONTEXT)) return selected;
  if (dockerAvailable(selected)) return selected;
  if (platform !== 'darwin') return selected;

  const rancherSocket = join(homeDir, '.rd', 'docker.sock');
  if (socketExists(rancherSocket)) {
    selected.DOCKER_HOST = `unix://${rancherSocket}`;
  }
  return selected;
}

export function dockerInfoIndicatesDaemon(result) {
  return processSucceeded(result) && nonEmpty(result.stdout);
}

export function containerRuntimeError(runtime, platform = process.platform) {
  if (runtime.status === 'missing') {
    return new Error(missingRuntimeMessage(platform));
  }
  if (runtime.status === 'missing-compose') {
    return new Error(
      'Docker was found, but Docker Compose v2 is missing. Install Compose v2, then run ' +
      'fl setup again.' +
      detailSuffix(runtime.detail)
    );
  }
  if (runtime.explicitTarget) {
    return new Error(
      'The container engine selected by DOCKER_HOST or DOCKER_CONTEXT is unavailable. Fix the ' +
      `configuration, confirm that docker info succeeds, then run fl setup again.${detailSuffix(runtime.detail)}`
    );
  }
  return new Error(
    'Docker and Compose were found, but the container engine is not running. Start Docker ' +
    'Desktop, Rancher Desktop, or the current Docker service; confirm that docker info succeeds; ' +
    'then run fl setup again.' +
    detailSuffix(runtime.detail)
  );
}

function resolveDockerCommand({ env, platform, homeDir, pathExists, run }) {
  const candidates = ['docker', ...bundledDockerCandidates({ env, platform, homeDir })];
  for (const command of candidates) {
    if (command !== 'docker' && !pathExists(command)) continue;
    if (processSucceeded(run(command, ['--version'], env))) return command;
  }
  return null;
}

function bundledDockerCandidates({ env, platform, homeDir }) {
  if (platform === 'darwin') {
    return [
      join(homeDir, '.rd', 'bin', 'docker'),
      '/Applications/Docker.app/Contents/Resources/bin/docker',
      join(homeDir, 'Applications', 'Docker.app', 'Contents', 'Resources', 'bin', 'docker')
    ];
  }
  if (platform === 'win32') {
    return [
      env.ProgramFiles && join(env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Rancher Desktop', 'resources',
        'resources', 'win32', 'bin', 'docker.exe')
    ].filter(Boolean);
  }
  return ['/usr/bin/docker', '/usr/local/bin/docker'];
}

function dockerCommandEnvironment(command, env, platform) {
  const selected = { ...env };
  if (platform !== 'darwin' || !command.includes('/Docker.app/')) return selected;
  const resources = command.slice(0, command.indexOf('/bin/docker'));
  const pluginDirectory = join(resources, 'cli-plugins');
  const current = nonEmpty(selected.DOCKER_CLI_PLUGIN_EXTRA_DIRS);
  selected.DOCKER_CLI_PLUGIN_EXTRA_DIRS = current
    ? `${current}${delimiter}${pluginDirectory}`
    : pluginDirectory;
  return selected;
}

function detectDesktopRuntime({ env, platform, homeDir, pathExists }) {
  const candidates = desktopCandidates({ env, platform, homeDir });
  const detected = candidates.find(({ applicationPath }) => pathExists(applicationPath));
  if (!detected) return null;

  if (detected.id === 'rancher-desktop') {
    const rdctlPath = platform === 'win32'
      ? join(dirname(detected.applicationPath), 'resources', 'resources', 'win32', 'bin',
        'rdctl.exe')
      : join(homeDir, '.rd', 'bin', 'rdctl');
    if (pathExists(rdctlPath)) {
      return {
        ...detected,
        launchCommand: rdctlPath,
        launchArgs: ['start']
      };
    }
  }
  if (platform === 'darwin') {
    return {
      ...detected,
      launchCommand: 'open',
      launchArgs: ['-a', detected.label]
    };
  }
  return {
    ...detected,
    launchCommand: detected.applicationPath,
    launchArgs: []
  };
}

function desktopCandidates({ env, platform, homeDir }) {
  if (platform === 'darwin') {
    return [
      {
        id: 'rancher-desktop',
        label: 'Rancher Desktop',
        applicationPath: '/Applications/Rancher Desktop.app'
      },
      {
        id: 'rancher-desktop',
        label: 'Rancher Desktop',
        applicationPath: join(homeDir, 'Applications', 'Rancher Desktop.app')
      },
      {
        id: 'docker-desktop',
        label: 'Docker Desktop',
        applicationPath: '/Applications/Docker.app'
      },
      {
        id: 'docker-desktop',
        label: 'Docker Desktop',
        applicationPath: join(homeDir, 'Applications', 'Docker.app')
      }
    ];
  }
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA && {
        id: 'rancher-desktop',
        label: 'Rancher Desktop',
        applicationPath: join(env.LOCALAPPDATA, 'Programs', 'Rancher Desktop',
          'Rancher Desktop.exe')
      },
      env.ProgramFiles && {
        id: 'rancher-desktop',
        label: 'Rancher Desktop',
        applicationPath: join(env.ProgramFiles, 'Rancher Desktop', 'Rancher Desktop.exe')
      },
      env.ProgramFiles && {
        id: 'docker-desktop',
        label: 'Docker Desktop',
        applicationPath: join(env.ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe')
      }
    ].filter(Boolean);
  }
  return [
    {
      id: 'rancher-desktop',
      label: 'Rancher Desktop',
      applicationPath: '/usr/bin/rancher-desktop'
    },
    {
      id: 'rancher-desktop',
      label: 'Rancher Desktop',
      applicationPath: '/opt/rancher-desktop/rancher-desktop'
    },
    {
      id: 'docker-desktop',
      label: 'Docker Desktop',
      applicationPath: '/usr/bin/docker-desktop'
    }
  ];
}

async function launchDesktopRuntime(desktop, { spawnProcess = spawn } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawnProcess(desktop.launchCommand, desktop.launchArgs, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function missingRuntimeMessage(platform) {
  if (platform === 'darwin') {
    return 'No usable Docker Compose container runtime was detected. Install and open Rancher ' +
      `Desktop (${RANCHER_DOWNLOAD_URL}) or Docker Desktop (${DOCKER_DOWNLOAD_URL}), then run ` +
      'fl setup again.';
  }
  if (platform === 'win32') {
    return 'No usable Docker Compose container runtime was detected. Enable WSL 2, then install ' +
      `and open Rancher Desktop (${RANCHER_DOWNLOAD_URL}) or Docker Desktop ` +
      `(${DOCKER_DOWNLOAD_URL}), and run fl setup again.`;
  }
  return 'No usable Docker Compose container runtime was detected. Install Docker Engine with ' +
    `Compose v2, or Rancher Desktop (${RANCHER_DOWNLOAD_URL}), then run fl setup again.`;
}

function defaultDockerAvailable(env) {
  return dockerInfoIndicatesDaemon(runProcess('docker', DOCKER_INFO_ARGS, env));
}

function runProcess(command, args, env) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function safeProcessDetail(result, homeDir) {
  const body = [result?.stderr, result?.stdout, result?.error?.message]
    .filter(nonEmpty)
    .join('\n')
    .replaceAll(homeDir, '~')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:password|token|secret)[\w-]*\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  return body.slice(0, 600);
}

function detailSuffix(detail) {
  return nonEmpty(detail) ? ` Docker returned: ${detail}` : '';
}

function processSucceeded(result) {
  return result?.status === 0 && !result.error;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
