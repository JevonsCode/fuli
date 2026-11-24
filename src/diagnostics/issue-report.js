import { release } from 'node:os';
import { clientSourceApplication, entryState } from '../agent-kits/client-detection.js';
import { FULI_VERSION } from '../package-metadata.js';
import { issueEventLine, publicSource } from './issue-event.js';
import { publicVersion } from './safe-event.js';
import { diagnosticEventsAnswer } from './query.js';
import { withinTimeLimit } from '../conversations/working-branch.js';

const REPORT_LIMIT = 30;
const CONFIG_STATES = new Set(['connected', 'changed', 'skills_left', 'removed', 'not_connected', 'not_detected']);
const ENTRY_STATES = new Set(['current', 'outdated', 'missing', 'conflict']);

const EN = {
  title: 'FULI diagnostics', configuration: 'MCP configuration', noConfig: 'Configuration: unavailable',
  noClients: 'No clients detected.', custom: 'Custom clients', processes: 'Registered MCP processes',
  unavailable: 'unavailable', observed: 'observed', recent: 'Recent failure events (newest first)',
  shown: (n, total) => `Events shown: ${n} / ${total} retained`,
  partial: (files, skipped) => `Event log: partial (unreadable files=${files}, skipped lines=${skipped})`,
  rotated: 'Older events may have rotated out.', empty: 'No failure events recorded in the retained log.',
  noLog: 'Event log: unavailable', slow: 'Configuration: scan still pending at report time. Refresh to check again.'
};
const ZH = {
  title: 'FULI 故障日志', configuration: 'MCP 客户端配置', noConfig: '客户端配置暂时无法读取',
  noClients: '未检测到客户端。', custom: '自定义客户端数量', processes: '已登记的 MCP 进程',
  unavailable: '暂时无法读取', observed: '个', recent: '最近的故障（最新在前）',
  shown: (n, total) => `显示 ${n} 条，本机共保留 ${total} 条。`,
  partial: (files, skipped) => `日志只读取了一部分，有 ${files} 个文件无法读取，跳过 ${skipped} 行。`,
  rotated: '更早的记录可能已轮换清理。', empty: '本机保留的日志中没有故障记录。', noLog: '本机故障日志暂时无法读取。',
  slow: '生成报告时客户端配置仍在检测，可刷新日志再查看。'
};

// No graph or personal space is needed. Configuration checks can themselves
// write a failure, so read the file after both observations have settled.
export function createIssueReport({ log, observeClients, liveProcesses, scanWaitMs = 3000 }) {
  let pending = null;
  return async locale => {
    // A slow scan remains available to the next refresh, even if it has
    // already finished by then. Concurrent readers share the same scan.
    const scan = pending ??= Promise.resolve().then(observeClients);
    const [config, processes] = await Promise.allSettled([
      withinTimeLimit(scan, scanWaitMs), Promise.resolve().then(liveProcesses)
    ]);
    if (config.value !== null && pending === scan) pending = null;
    return formatReport(log, config.value, processes.value, locale);
  };
}

function formatReport(log, config, processes, locale) {
  const words = locale === 'zh-CN' ? ZH : EN;
  const lines = [`## ${words.title}`, '', `FULI ${FULI_VERSION} | ${process.platform} ${/^\d+(?:\.\d+)*/.exec(release())?.[0] ?? ''} ${process.arch} | ${new Date().toISOString()}`,
    '', `### ${words.recent}`];
  try {
    const page = diagnosticEventsAnswer(log, { limit: REPORT_LIMIT });
    const missing = page.sourcesUnavailable.length;
    lines.push(words.shown(page.events.length, page.total));
    if (missing || page.skippedLines) lines.push(words.partial(missing, page.skippedLines));
    if (page.truncatedBy.includes('retention')) lines.push(words.rotated);
    if (page.events.length) lines.push('', '```text', ...page.events.map(issueEventLine), '```');
    else if (!missing && !page.skippedLines) lines.push(words.empty);
  } catch { lines.push(words.noLog); }
  lines.push('', `### ${words.configuration}`, ...configurationLines(config, words), '', ...processLines(processes, words));
  return lines.join('\n');
}

function configurationLines(result, words) {
  if (result === null) return [words.slow];
  if (!result?.available) return [words.noConfig];
  const lines = [];
  if (typeof result.observedAt === 'string' && Number.isFinite(Date.parse(result.observedAt)))
    lines.push(new Date(result.observedAt).toISOString());
  for (const client of result.clients) {
    const source = clientSourceApplication(client.id) ?? 'other';
    const state = entryState(client.components);
    const parts = [`- ${source}: config=${CONFIG_STATES.has(client.status) ? client.status : 'unknown'}`,
      `entry=${ENTRY_STATES.has(state) ? state : 'unknown'}`];
    if (client.configuredInstall) {
      parts.push(`target=${client.configuredInstall.exists ? 'present' : 'missing'}`, `target_version=${publicVersion(client.configuredInstall.version)}`);
      const slot = /(?:^|[\\/])app-([^\\/]+)(?:[\\/]|$)/i.exec(client.configuredInstall.path ?? '');
      if (slot && publicVersion(slot[1]) !== 'unknown') parts.push(`target_slot=${publicVersion(slot[1])}`);
    }
    if (client.overwritten) parts.push('configuration_overwritten=true');
    if (Number.isSafeInteger(client.restartSessions) && client.restartSessions > 0) parts.push(`restart_pending=${client.restartSessions}`);
    lines.push(parts.join(' | '));
  }
  if (result.customClients?.length) lines.push(`${words.custom}: ${result.customClients.length}`);
  return lines.length ? lines : [words.noClients];
}

function processLines(records, words) {
  if (!Array.isArray(records)) return [`${words.processes}: ${words.unavailable}`];
  const groups = new Map();
  for (const record of records) {
    const key = `${publicSource(record.sourceApplication)} | FULI ${publicVersion(record.version)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [`${words.processes}: ${records.length} ${words.observed}`, ...[...groups.keys()].sort().map(key => `- ${key} | count=${groups.get(key)}`)];
}
