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

  onProgress(`正在启动 ${runtime.desktop.label}，首次启动可能需要几分钟…`);
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
    `${runtime.desktop?.label ?? runtime.label} 已启动，但容器引擎未在 ` +
    `${Math.ceil(maxWaitMs / 1000)} 秒内就绪。请打开该应用查看错误，确认 docker info ` +
    `可以成功后重新运行 fl setup。${detailSuffix(runtime.detail)}`
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
    throw new Error(`Fuli 需要的本地端口已被占用。${detailSuffix(detail)}`);
  }
  if (/cannot connect|connection refused|error during connect|docker daemon|\bEOF\b/i.test(detail)) {
    throw new Error(`容器运行时在启动 Fuli Provider 时失去连接。${detailSuffix(detail)}`);
  }
  throw new Error(`Docker Compose 无法启动 Fuli Provider。${detailSuffix(detail)}`);
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
      `已找到 Docker，但缺少 Docker Compose v2。请安装 Compose v2 后重新运行 fl setup。` +
      detailSuffix(runtime.detail)
    );
  }
  if (runtime.explicitTarget) {
    return new Error(
      `DOCKER_HOST 或 DOCKER_CONTEXT 指向的容器引擎不可用。请修复该配置并确认 ` +
      `docker info 可以成功后重新运行 fl setup。${detailSuffix(runtime.detail)}`
    );
  }
  return new Error(
    `已找到 Docker 和 Compose，但容器引擎没有运行。请启动 Docker Desktop、` +
    `Rancher Desktop 或当前 Docker 服务，确认 docker info 可以成功后重新运行 fl setup。` +
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
    return `未检测到可用的 Docker Compose 容器运行时。请安装并首次打开 Rancher Desktop ` +
      `(${RANCHER_DOWNLOAD_URL}) 或 Docker Desktop (${DOCKER_DOWNLOAD_URL})，` +
      `然后重新运行 fl setup。`;
  }
  if (platform === 'win32') {
    return `未检测到可用的 Docker Compose 容器运行时。请先启用 WSL 2，再安装并首次打开 ` +
      `Rancher Desktop (${RANCHER_DOWNLOAD_URL}) 或 Docker Desktop ` +
      `(${DOCKER_DOWNLOAD_URL})，然后重新运行 fl setup。`;
  }
  return `未检测到可用的 Docker Compose 容器运行时。请安装 Docker Engine + Compose v2，` +
    `或 Rancher Desktop (${RANCHER_DOWNLOAD_URL})，然后重新运行 fl setup。`;
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
  return nonEmpty(detail) ? ` Docker 返回：${detail}` : '';
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
