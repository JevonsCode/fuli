import { routingRoleState } from './routing-setup.js';

// The one description of where a follower stands (docs/runner-roles-design.md
// §5): who it follows, whether that computer answers now, when it last did,
// what waits in its outbox, and which capability runs where. The console entry
// (follower-console.js), `fuli status` and `fuli runner status` all read this,
// so the three never disagree about whether the host is reachable — the
// complaint in rec#144 and rec#148. Every caller asks the same host connection
// (host-connection.js), which is also what a client's MCP process asks.
//
// A capability says where it runs and what it does while the host is away.
// Where: `host` (the computer that owns the scope), `local` (this computer's
// own) or `replica` (this computer's read-only copy of a scope another computer
// owns, with `syncedAt`) — the three answers of docs/runner-roles-design.md §3;
// nothing is a copy until a follower owns a scope (step 3). Offline: `cached`
// (the host's last answer, marked offline), `queued` (kept here and delivered
// when the host answers), `works` (it never needed the host) or `unavailable`.
export const CAPABILITIES = Object.freeze([
  { id: 'task_entry', where: 'host', offline: 'cached',
    zh: '任务入口：习惯、FLA、项目知识', en: 'Task entry: habits, FLAs, project knowledge' },
  { id: 'checkpoint', where: 'host', offline: 'queued',
    zh: '交接（checkpoint）', en: 'Checkpoints' },
  { id: 'reads', where: 'host', offline: 'cached',
    zh: '只读查询：知识搜索、助手名册', en: 'Read-only calls: knowledge search, the FLA roster' },
  { id: 'resume_conversation', where: 'host', offline: 'cached',
    zh: '接上之前的会话', en: 'Continuing an earlier conversation' },
  { id: 'executor_judgment', where: 'local', offline: 'works',
    zh: '执行器判断（本机 Tonborg，需在本机配置）', en: 'Executor judgment (this computer\'s Tonborg, set up here)' },
  { id: 'clients', where: 'local', offline: 'works',
    zh: '客户端接入：本机的 Agent 客户端', en: '客户端接入: this computer\'s Agent clients' },
  { id: 'writes', where: 'host', offline: 'unavailable',
    zh: '其他写操作', en: 'Other calls that change something' },
  { id: 'host_console', where: 'host', offline: 'unavailable',
    zh: '主机的配对、更新、设置和诊断', en: 'The host\'s pairing, updates, settings and diagnostics' }
]);

// Said plainly wherever the state is shown. The two computers reach each other
// directly or not at all: FULI runs no relay of its own, by decision
// (docs/runner.md "Finding the host again").
export const SAME_NETWORK_LIMIT = Object.freeze({
  zh: '两台电脑要能互相连到：同一个局域网，或同一个 VPN / 组网工具给出的地址。',
  en: 'The two computers must be able to reach each other: one LAN, or an address a VPN or mesh tool gives them.'
});

// reach: whether to ask the host now. Without it the answer carries `reachable`
// as given (null: not checked), for a caller that already knows or must not
// open a connection.
export async function followerStatus({ store, connection, dataDir = null, reach = true, reachable = null }) {
  const host = store.host();
  if (!host) return { paired: false, host: null, outbox: store.outbox(), capabilities: capabilities(dataDir) };
  // The host answering hello now, not a connection kept from earlier: a host
  // that went away since is not shown as there (hello drops what does not answer).
  const answered = reach && !host.revokedAt ? await connection.hello() : null;
  const reached = answered ? connection.current : null;
  // Looking for the host may have learned that this computer was revoked; read the row again.
  const after = store.host() ?? host;
  const sessions = answered?.mcpSessions ?? null;
  return {
    paired: true,
    host: { name: after.name, pairedAt: after.pairedAt, revokedAt: after.revokedAt ?? null,
      reachable: reach ? Boolean(reached) && !after.revokedAt : reachable,
      address: reached?.address ?? null, via: reached?.via ?? null,
      lastSeenAt: after.lastSeenAt ?? null, answeredAt: store.answeredAt(),
      pinFailed: reach ? Boolean(!reached && connection.pinFailed) : false,
      ...(sessions ? { mcpSessions: sessions } : {}) },
    outbox: store.outbox(),
    capabilities: capabilities(dataDir)
  };
}

// Where each capability runs on this computer. Only the executor judgment
// differs between followers: it runs here while the person set a Tonborg model
// up here (docs/runner.md "Executor judgment on a runner").
function capabilities(dataDir) {
  const localJudgment = dataDir ? routingRoleState(dataDir).state === 'on' : false;
  return CAPABILITIES.map((capability) => capability.id !== 'executor_judgment' ? capability
    : { ...capability, ...(localJudgment ? {} : { where: 'host', offline: 'unavailable' }) });
}

// The one line every surface shows first.
export function followerLine(status) {
  if (!status.paired) return { zh: '这台电脑还没有跟随任何主机。', en: 'This computer follows no host yet.' };
  const { name, reachable, revokedAt } = status.host;
  if (revokedAt) return { zh: `${name} 已撤销这台电脑。`, en: `${name} revoked this computer.` };
  const where = reachable === null ? { zh: '未检查', en: 'not checked' }
    : reachable ? { zh: '在线', en: 'answering' } : { zh: '不在线', en: 'not reachable' };
  // When the host last answered anything this computer asked: when it was last reached, not when
  // data was last exchanged, and named so.
  const reachedAt = status.host.lastSeenAt ?? status.host.answeredAt;
  return {
    zh: `跟随 ${name} · ${where.zh} · 上次连上 ${reachedAt ?? '还没有'} · 待送 ${status.outbox.queued}`,
    en: `Following ${name} · ${where.en} · last reached ${reachedAt ?? 'never'} · ${status.outbox.queued} waiting`
  };
}
