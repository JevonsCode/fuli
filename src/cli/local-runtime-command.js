import {
  inspectLocalRuntime,
  openLocalConsole,
  restartLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime
} from '../local-runtime/lifecycle.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { parseLocalRuntimeOptions } from './local-runtime-options.js';

export async function runLocalRuntimeCommand(command, args, dependencies = {}) {
  const options = parseLocalRuntimeOptions(command, args);
  const resolvePaths = dependencies.resolvePaths ?? resolveSetupPaths;
  const env = dependencies.env ?? process.env;
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const write = dependencies.write ?? writeLine;
  const input = { ...options, paths, env, onProgress: write };
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
    const verb = result.status === 'running' ? '已经在运行' : '已启动';
    return formatStartedRuntime(`Fuli 本地服务${verb}。`, result);
  }
  if (command === 'restart') {
    return formatStartedRuntime('Fuli 本地服务已重启。', result);
  }
  if (command === 'stop') {
    if (result.status === 'partial') {
      return [
        'Fuli 本地 Provider 已停止，但没有终止无法验证身份的界面进程。',
        '请执行 fl status 检查，避免误停其他进程。'
      ].join('\n');
    }
    return result.console === 'not_running' && result.providers === 'not_initialized'
      ? 'Fuli 本地服务尚未初始化。'
      : 'Fuli 本地服务已停止，图谱数据已保留。';
  }
  if (command === 'open') return `已打开：${result.url}`;
  if (command === 'status') return formatStatus(result);
  throw new TypeError(`Unknown local runtime command: ${command}`);
}

function formatStartedRuntime(title, result) {
  const lines = [title, `管理界面：${result.url}`];
  if (result.lan === true) {
    lines.push(
      '局域网界面：',
      ...result.lanUrls.map((url) => `  ${url}`),
      `访问用户名：${result.lanAccess.username}`,
      `临时访问口令：${result.lanAccess.accessCode}`,
      '仅在可信 Wi-Fi 中使用；重新启动局域网模式会更换口令。'
    );
  }
  return lines.join('\n');
}

function formatStatus(result) {
  const labels = {
    running: '运行中',
    degraded: '部分可用',
    stopped: '已停止',
    not_configured: '未初始化',
    ready: '可用',
    unavailable: '不可用',
    not_connected: '未连接',
    not_configured_provider: '未配置',
    unverified: '身份未验证'
  };
  const publicSummary = result.public.configured
    ? `${labels[result.public.status] ?? result.public.status}（${result.public.providers.length} 个 Provider）`
    : labels.not_connected;
  return [
    `Fuli 本地状态：${labels[result.status] ?? result.status}`,
    `管理界面：${labels[result.console.status] ?? result.console.status} · ${result.console.url}`,
    `个人图谱：${providerLabel(result.personal.status, labels)}`,
    `公共服务：${publicSummary}`
  ].join('\n');
}

function providerLabel(status, labels) {
  if (status === 'not_configured') return labels.not_configured_provider;
  return labels[status] ?? status;
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
