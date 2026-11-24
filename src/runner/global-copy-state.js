import { join } from 'node:path';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

// Where this computer's read-only copy of the host's `global` stands
// (global-sync.js), as every surface says it: the state band, `/local`,
// `fuli status` and `fuli runner status` (follower-status.js).
//
// The time the copy was last brought up to date is in the routes store
// (`replica_synced_at` of `global`), with the rest of the routes. COPY_FILE
// keeps what a sync needs besides: the digest of the copy, when it was last
// checked against the host and when its content last changed, and how the
// last try went. Process state, not FULI data: without it the next sync
// imports once more, which writes nothing the copy already has.
//   { digest, checkedAt, changedAt, dueSoon?,
//     last: { at, outcome, reason?, code?, message?, by?, digest?, host?, own?, spaceId?, bytes?, max? } }
// dueSoon: when this computer's writes to global were last applied by the host (requestSyncSoon).
// outcome:
//   'synced'           brought up to date (digest changed) or checked unchanged
//   'waiting'          reason: host_unreachable | host_provider_unavailable | host_provider_slow
//                      | host_space_pending: tried again by itself
//                      | own_import_unfinished: this computer's own import did not finish (cause: timeout |
//                      interrupted); with digest, host, own, spaceId: its runtime is not started for the copy
//                      again in the same situation (copyWorthStarting) until the host's content or a version
//                      changes, or the person presses 「重新准备」 (again: true)
//   'host_cannot_copy' the host's FULI has no copies to give (404, or its hello says no space)
//   'versions_differ'  host / own: { graph, replicaProtocol }; not imported until one changes
//   'space_differs'    this computer's graph is another personal space than the host's
//   'refused'          by: host | here; code and message as said; not tried again for the same
//                      digest, versions and space; phase: 'digest' when the digest itself was refused
//                      (no digest to compare: asked again after a day, or once a version or the space changed)
// last.corrected: a verifying import found this graph's copy other than the host's and wrote it back.
export const COPY_FILE = join('runner', 'global-copy.json');
// How often a running runtime checks its copy against the host (global-sync.js).
export const GLOBAL_SYNC_EVERY_MS = 10 * 60_000;

export function readGlobalCopyRecord(dataDir) {
  try {
    const record = readJsonFile(join(dataDir, COPY_FILE), null);
    return record && typeof record === 'object' ? record : {};
  } catch { return {}; }
}

// last: how this try went. A sync that found the copy as the host has it also passes
// { digest, checkedAt, changedAt? }; anything else keeps them.
export function recordGlobalCopy(dataDir, { last, ...found }) {
  writeJsonFileAtomic(join(dataDir, COPY_FILE), { ...readGlobalCopyRecord(dataDir), ...found, last });
}

export const IMPORT_UNFINISHED = 'own_import_unfinished';

// The host applied writes to global this computer sent (global-writes-outbox.js):
// the copy is out of date, so the next sync is due now rather than in
// GLOBAL_SYNC_EVERY_MS. Written by an MCP process; the console's sync, which
// alone imports, is to read it, and a check after it answers it.
export function requestSyncSoon(dataDir, { now = Date.now } = {}) {
  writeJsonFileAtomic(join(dataDir, COPY_FILE), { ...readGlobalCopyRecord(dataDir), dueSoon: new Date(now()).toISOString() });
}

export function syncSoonDue(record, lastRoundAt) {
  const requested = Date.parse(record.dueSoon);
  return Number.isFinite(requested) && requested > (lastRoundAt ?? -Infinity);
}

// The graph was restored or the importer needs to establish a new baseline.
export function forgetDigest(dataDir) {
  const record = readGlobalCopyRecord(dataDir);
  writeJsonFileAtomic(join(dataDir, COPY_FILE), { ...record, digest: null, contentDigest: null,
    checkedAt: null, last: null, dueSoon: new Date().toISOString() });
}

// 「重新准备」: the person asks for the runtime to be started for the copy once more.
export function allowImportAgain(dataDir) {
  const record = readGlobalCopyRecord(dataDir);
  if (record.last?.reason !== IMPORT_UNFINISHED) return;
  writeJsonFileAtomic(join(dataDir, COPY_FILE), { ...record, last: { ...record.last, again: true } });
}

// What every surface shows. syncedAt: the routes store's `replica_synced_at` of `global`;
// running: whether this computer's own runtime runs (then it checks every GLOBAL_SYNC_EVERY_MS).
export function describeGlobalCopy(dataDir, { syncedAt = null, running = false } = {}) {
  const record = readGlobalCopyRecord(dataDir);
  const last = record.last && typeof record.last === 'object' ? record.last : null;
  return { syncedAt, checkedAt: record.checkedAt ?? null, changedAt: record.changedAt ?? null,
    last, running, everyMinutes: GLOBAL_SYNC_EVERY_MS / 60_000 };
}

const PREFIX = { zh: '全局副本（习惯、助手名册）：', en: 'Copy of global (habits, the FLA roster): ' };
const HOST_ONLY = { zh: '转发到主机的调用不受影响。', en: 'Calls that go to the host are not affected.' };

// One line, both languages: when it was last brought up to date, what stands in its way, and
// when it is tried next. Never a terminal command: what is left to do is said as what to do.
export function globalCopyLine(copy) {
  if (!copy) return null;
  const parts = [copy.checkedAt
    ? { zh: `上次核对 ${copy.checkedAt}，内容上次变化于 ${copy.changedAt ?? copy.syncedAt ?? copy.checkedAt}。`,
      en: `last checked ${copy.checkedAt}; its content last changed ${copy.changedAt ?? copy.syncedAt ?? copy.checkedAt}.` }
    : { zh: '还没同步过。', en: 'not synced yet.' }];
  const problem = problemLine(copy.last);
  if (problem) parts.push(problem, HOST_ONLY);
  parts.push(nextLine(copy));
  return { zh: PREFIX.zh + parts.map(({ zh }) => zh).join(''), en: PREFIX.en + parts.map(({ en }) => en).join(' ') };
}

// The short part for the line every surface shows first (follower-status.js followerLine).
export function globalCopyShort(copy) {
  if (!copy) return null;
  const outcome = copy.last?.outcome;
  if (outcome === 'versions_differ') return { zh: '全局副本：两边版本不一致', en: 'global copy: versions differ' };
  if (outcome === 'refused') return { zh: '全局副本被拒绝', en: 'global copy refused' };
  if (outcome === 'host_cannot_copy') return { zh: '全局副本：主机需升级', en: 'global copy: update the host' };
  if (outcome === 'space_differs') return { zh: '全局副本：空间不同', en: 'global copy: another space' };
  return copy.checkedAt ? { zh: `全局副本核对于 ${copy.checkedAt}`, en: `global copy checked ${copy.checkedAt}` }
    : { zh: '全局副本未同步', en: 'global copy not synced yet' };
}

function nextLine(copy) {
  const outcome = copy.last?.outcome;
  if (outcome === 'versions_differ' || outcome === 'host_cannot_copy' || outcome === 'space_differs') {
    return { zh: '情况变了之后自动继续。', en: 'It goes on by itself once that changes.' };
  }
  if (copy.last?.reason === IMPORT_UNFINISHED && !copy.running) {
    return { zh: '为这份副本启动过一次本机运行时，导入没完成；主机内容或任一方 FULI 版本变了之后才会再启动，或按「重新准备」。',
      en: 'This computer\'s runtime was started once for this copy and the import did not finish; it is started for it again '
        + 'only once the host\'s content or either FULI version changes, or when 「重新准备 / Prepare again」 is pressed.' };
  }
  if (copy.running) {
    return { zh: `本机运行时在运行：每 ${copy.everyMinutes} 分钟问一次主机，有变化才取。`,
      en: `This computer's runtime runs: the host is asked every ${copy.everyMinutes} minutes, and the copy fetched only when it changed.` };
  }
  return copy.checkedAt
    ? { zh: '本机运行时现在没有运行，下次在它运行时再核对；平时不会为了同步专门启动它，只在 FULI 升级后启动一次。',
      en: 'This computer\'s runtime does not run now; the copy is checked next while it runs. It is not started for a sync, '
        + 'except once after FULI is updated.' }
    : { zh: '这台电脑的控制台启动、且主机在线时补上第一份：为此启动一次本机运行时，完成后停掉。',
      en: 'The first copy comes once this computer\'s console runs and the host answers: its runtime is started once for it, '
        + 'then stopped again.' };
}

function problemLine(last) {
  switch (last?.outcome) {
    case 'waiting':
      return WAITING[last.reason] ?? WAITING.host_unreachable;
    case 'host_cannot_copy':
      return { zh: '主机的 FULI 还不能提供副本，升级主机后继续。',
        en: 'The host\'s FULI cannot give a copy yet; update FULI there and it goes on.' };
    case 'versions_differ':
      return versionsLine(last);
    case 'space_differs':
      return { zh: '本机图谱和主机不是同一个空间，所以不同步；这台电脑原来的数据没有动。',
        en: 'This computer\'s graph is another personal space than the host\'s, so nothing is synced; its own data was left as it is.' };
    case 'refused':
      return refusedLine(last);
    default:
      return null;
  }
}

const WAITING = {
  host_unreachable: { zh: '上次同步时主机不在线，连上后再同步。',
    en: 'The host did not answer at the last try; the copy is synced once it does.' },
  host_provider_unavailable: { zh: '上次同步时主机的数据库没在运行，稍后自动再试。',
    en: 'The host\'s graph did not run at the last try; tried again later by itself.' },
  host_provider_slow: { zh: '上次同步时主机的数据库太忙，稍后自动再试。',
    en: 'The host\'s graph was too busy at the last try; tried again later by itself.' },
  host_space_pending: { zh: '主机还没读出它的空间，稍后自动再试。',
    en: 'The host has not read its personal space yet; tried again later by itself.' },
  replica_summary_unavailable: { zh: '本机 Provider 没有回答副本摘要，等它恢复后再核对。',
    en: 'The local Provider could not read the replica summary; it will be checked again.' },
  own_import_unfinished: { zh: '上次同步时本机导入没完成（超时或中断），什么都没记为已同步。',
    en: 'This computer\'s own import did not finish at the last try (it timed out or was interrupted); nothing was '
      + 'recorded as synced.' }
};

// The older side is the one with the lower graph format (or copy protocol): the one to update.
function versionsLine({ host = {}, own = {} }) {
  const older = (host.graph ?? 0) !== (own.graph ?? 0) ? ((host.graph ?? 0) < (own.graph ?? 0) ? 'host' : 'own')
    : ((host.replicaProtocol ?? 0) < (own.replicaProtocol ?? 0) ? 'host' : 'own');
  const which = older === 'host' ? { zh: '主机', en: 'the host' } : { zh: '这台电脑', en: 'this computer' };
  return { zh: `两台电脑的 FULI 版本不一致（主机：图谱格式 ${host.graph ?? '?'}、副本协议 ${host.replicaProtocol ?? '?'}；`
      + `这台电脑：${own.graph ?? '?'}、${own.replicaProtocol ?? '?'}），没有同步。把${which.zh}的 FULI 升级后继续。`,
    en: `The two computers run different FULI versions (the host: graph format ${host.graph ?? '?'}, copy protocol `
      + `${host.replicaProtocol ?? '?'}; this computer: ${own.graph ?? '?'}, ${own.replicaProtocol ?? '?'}), so nothing was synced. `
      + `Update FULI on ${which.en} and it goes on.` };
}

// A refusal, said as what it is and by whom, with its code: nothing was written, and the
// same refusal is not tried again until the host's content, a version or the space changes.
const REASONS = {
  scope_not_owned_here: { zh: '主机自己的全局也是别的电脑的副本，只有拥有它的那台电脑能提供',
    en: 'the host\'s own global is a copy of another computer\'s; only that computer can give it' },
  scope_too_large: { zh: '副本超过了一次能带的大小上限', en: 'the copy is larger than one copy may be' },
  replica_envelope_incomplete: { zh: '主机的导出不完整（有这个版本还不认识的记录），等主机的 FULI 升级',
    en: 'the host\'s export is incomplete (records this version does not know yet); FULI there needs an update' },
  replica_space_mismatch: { zh: '本机图谱的空间和主机的不同', en: 'this computer\'s graph is another space than the host\'s' },
  replica_owner_changed: { zh: '本机现有的全局副本来自另一台主机，换主机的接管还没有做',
    en: 'the copy of global here came from another host; taking a copy over to a new host comes later' },
  replica_scope_owned_here: { zh: '本机有自己写的全局记录，和主机的同 ID 记录冲突，合并还没有做',
    en: 'this computer wrote records of global of its own under IDs the host\'s copy uses; merging them comes later' },
  replica_format_mismatch: { zh: '两边的图谱格式不同，升级到同一版本后继续', en: 'the two graph formats differ; both need one FULI version' },
  replica_protocol_unknown: { zh: '两边的副本协议不同，升级到同一版本后继续', en: 'the two copy protocols differ; both need one FULI version' }
};
function refusedLine(last) {
  const who = last.by === 'host' ? { zh: '主机', en: 'The host' } : { zh: '这台电脑', en: 'This computer' };
  const reason = REASONS[last.code] ?? { zh: last.message || '没有说明原因', en: last.message || 'no reason given' };
  return { zh: `${who.zh}拒绝了这份副本（${last.code}）：${reason.zh}。什么都没写；主机的内容、版本或空间变了之后才会再试。`,
    en: `${who.en} refused the copy (${last.code}): ${reason.en}. Nothing was written; it is tried again only once the host's `
      + 'content, a version or the space changes.' };
}
