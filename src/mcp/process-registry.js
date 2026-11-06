import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeJsonFileAtomic } from '../storage/json-file.js';

// Every stdio MCP server records its version beside the runtime config. A
// relayed server (stdio-relay.js) moves to an update by itself once idle; a
// server a client started before the relay existed does not, so a hook (always
// the installed version) can tell the person once per session that an open
// client still runs an older FULI and should be restarted.
const directory = runtimeConfigPath => join(dirname(runtimeConfigPath), 'mcp-processes');

// What a task entry hands an MCP server (taskContextToken, frames, rule
// references). Raise it when an older server can no longer read what the
// installed hook delivers; a record without it predates this contract. A
// server of another version on the same contract only misses the update.
export const TASK_ENTRY_CONTRACT = 2;

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

// The sessions a server most recently answered, newest last, so the doctor can
// offer to open each session that still runs an older FULI.
const MAX_SESSIONS = 8;
const MAX_SESSION_ID = 512;

// Returns { recordSession, unregister }. recordSession(sessionId) notes the
// session of a call; the file is rewritten only when the list changes, and a
// failed write never fails the call.
export function registerMcpProcess(runtimeConfigPath, { sourceApplication, version, pid = process.pid,
  entryContract = TASK_ENTRY_CONTRACT, sessionStartedAt = null }) {
  const path = join(directory(runtimeConfigPath), `${pid}.json`);
  const startedAt = new Date().toISOString();
  const record = { pid, version, entryContract, sourceApplication: sourceApplication ?? null,
    startedAt, sessionStartedAt: sessionStartedAt ?? startedAt, sessionIds: [] };
  try { writeJsonFileAtomic(path, record); } catch { return { recordSession: () => {}, unregister: () => {} }; }
  return {
    recordSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SESSION_ID
        || record.sessionIds.at(-1) === sessionId) return;
      record.sessionIds = [...record.sessionIds.filter(id => id !== sessionId), sessionId].slice(-MAX_SESSIONS);
      try { writeJsonFileAtomic(path, record); } catch { /* best effort: the next new session writes again */ }
    },
    unregister: () => { try { rmSync(path, { force: true }); } catch { /* best effort */ } }
  };
}

// Every live server's record ({ pid, version, entryContract, sourceApplication, startedAt, sessionIds });
// files of exited processes are removed on the way.
export function liveMcpProcesses(runtimeConfigPath, { isAlive = alive } = {}) {
  let names;
  try { names = readdirSync(directory(runtimeConfigPath)); } catch { return []; }
  const live = [];
  // In pid order, so a reader's answer does not follow the file system's.
  for (const name of names.filter(item => /^\d+\.json$/.test(item)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const path = join(directory(runtimeConfigPath), name);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (!isAlive(record.pid)) { rmSync(path, { force: true }); continue; }
      live.push(record);
    } catch { /* unreadable entry: skip */ }
  }
  return live;
}

// A client reads its Skills and hooks when a session starts, so what was written
// into it stays unread by the sessions already open. The MCP server moves to an
// update by itself; these don't. A write leaves this note, and a session started
// later is not waiting: restarting clears the prompt with no one to tell.
export function noteClientChanged(runtimeConfigPath, sourceApplication, changedAt = new Date()) {
  writeJsonFileAtomic(join(directory(runtimeConfigPath), `client-changed-${sourceApplication}.json`),
    { sourceApplication, changedAt: changedAt.toISOString() });
}

// Per client, the open sessions that started before its last change:
// { sourceApplication, count, changedAt, sessions }.
export function sessionsAwaitingRestart(runtimeConfigPath, { isAlive = alive } = {}) {
  let names;
  try { names = readdirSync(directory(runtimeConfigPath)); } catch { return []; }
  const live = liveMcpProcesses(runtimeConfigPath, { isAlive });
  return names.filter(name => /^client-changed-.+\.json$/.test(name)).sort().flatMap((name) => {
    let change;
    try { change = JSON.parse(readFileSync(join(directory(runtimeConfigPath), name), 'utf8')); } catch { return []; }
    const waiting = live.filter(record => record.sourceApplication === change.sourceApplication
      && (record.sessionStartedAt ?? record.startedAt) < change.changedAt);
    return waiting.length ? [{ sourceApplication: change.sourceApplication, count: waiting.length, changedAt: change.changedAt,
      sessions: [...new Set(waiting.flatMap(record => record.sessionIds ?? []))] }] : [];
  });
}

// Live servers of this client that run a different version.
export function outdatedMcpProcesses(runtimeConfigPath, { sourceApplication, version, isAlive = alive }) {
  return liveMcpProcesses(runtimeConfigPath, { isAlive })
    .filter(record => record.sourceApplication === sourceApplication && record.version !== version);
}

// The one-time notice for this session, or null. Shown again only when the
// set of outdated versions changes. The marker records whom it told and what.
// A server on an older task-entry contract may not read this entry's token
// (rec#74), so the notice then says so and what to do; one that answered this
// very session is named as this session's own.
export function outdatedMcpNotice(runtimeConfigPath, { sourceApplication, version, sessionId, isAlive = alive,
  clock = () => new Date() }) {
  const outdated = outdatedMcpProcesses(runtimeConfigPath, { sourceApplication, version, isAlive });
  if (typeof sessionId !== 'string') return null;
  if (!outdated.length) return clientChangedNotice(runtimeConfigPath, { sourceApplication, sessionId, isAlive, clock });
  const versions = [...new Set(outdated.map(record => record.version))].sort();
  const incompatible = outdated.filter(record => record.entryContract !== TASK_ENTRY_CONTRACT);
  const own = incompatible.filter(record => Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId));
  const kind = own.length ? 'this_session' : incompatible.length ? 'maybe_this_session' : 'update_only';
  const marker = join(directory(runtimeConfigPath), `noticed-${createHash('sha256')
    .update(JSON.stringify([sourceApplication, sessionId, versions])).digest('hex').slice(0, 24)}`);
  try {
    writeFileSync(marker, JSON.stringify({ sourceApplication, sessionId, installed: version, versions, kind,
      noticedAt: clock().toISOString() }), { flag: 'wx' });
  } catch { return null; }
  if (kind === 'update_only') return restartNotice(version, outdated.length, sourceApplication, versions);
  const older = own.length ? own : incompatible;
  return tokenNotice(version, [...new Set(older.map(record => record.version))].sort(), own.length ? null : older.length,
    sourceApplication);
}

// Once per session and change, and only to a session that is itself waiting.
function clientChangedNotice(runtimeConfigPath, { sourceApplication, sessionId, isAlive, clock }) {
  const waiting = sessionsAwaitingRestart(runtimeConfigPath, { isAlive })
    .find(entry => entry.sourceApplication === sourceApplication && entry.sessions.includes(sessionId));
  if (!waiting) return null;
  const marker = join(directory(runtimeConfigPath), `noticed-${createHash('sha256')
    .update(JSON.stringify([sourceApplication, sessionId, waiting.changedAt])).digest('hex').slice(0, 24)}`);
  try {
    writeFileSync(marker, JSON.stringify({ sourceApplication, sessionId, changedAt: waiting.changedAt, kind: 'client_changed',
      noticedAt: clock().toISOString() }), { flag: 'wx' });
  } catch { return null; }
  return 'FULI updated its Skills or hooks in this client after this session started. Tell the person to restart this session to load them. / '
    + 'FULI 更新了这个客户端里的 Skills 或 Hooks，本会话是更新前开的，请告诉用户重启本会话才会用上。';
}

const restartNotice = (version, count, sourceApplication, versions) =>
  `FULI ${version} is installed, but ${count} open ${sourceApplication} session(s) still run FULI ${versions.join(', ')}. `
  + 'Restart those sessions to load it (it uses fewer tokens). / 已安装 FULI ' + version + '，但有 ' + count
  + ' 个打开的会话还在用旧版 ' + versions.join('、') + '，重启这些会话即可加载新版（更省 Token）。';

// count is null when this session's own server is one of them.
const tokenNotice = (version, versions, count, sourceApplication) => (count === null
  ? `This session's FULI MCP connection runs FULI ${versions.join(', ')}, older than the installed ${version}; `
    + 'it may not read this taskContextToken. If a FULI call with it fails, '
  : `${count} open ${sourceApplication} session(s) still have a FULI MCP connection on FULI ${versions.join(', ')}, `
    + `older than the installed ${version}, which may not read this taskContextToken. If this session is one and a FULI call with it fails, `)
  + 'ask the person to restart this session\'s FULI MCP connection or open a new session, and meanwhile call '
  + 'get_collaboration_preferences for a token that connection can read. / '
  + (count === null ? `本会话的 FULI MCP 连接还是 ${versions.join('、')}，早于已安装的 ${version}，可能读不了本轮 token。`
    : `有 ${count} 个打开的会话的 FULI MCP 连接还是 ${versions.join('、')}，早于已安装的 ${version}，可能读不了本轮 token；如果本会话是其中之一，`)
  + '带它的 FULI 调用失败时，请用户重连本会话的 FULI MCP 或新开会话，在此之前先调 get_collaboration_preferences 换一个它能读的 token。';

// Adds the notice to a UserPromptSubmit hook output without touching anything else.
export function withOutdatedMcpNotice(output, notice) {
  if (!notice || !output || typeof output !== 'object') return output;
  const specific = output.hookSpecificOutput;
  return {
    ...output,
    systemMessage: output.systemMessage ? `${output.systemMessage}\n${notice}` : notice,
    ...(specific ? { hookSpecificOutput: { ...specific,
      additionalContext: specific.additionalContext ? `${specific.additionalContext}\n${notice}` : notice } } : {})
  };
}
