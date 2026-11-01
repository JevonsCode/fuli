import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeJsonFileAtomic } from '../storage/json-file.js';

// Every stdio MCP server records its version beside the runtime config. An
// update does not restart servers that clients already started, so a hook
// (always the installed version) can tell the person once per session that an
// open client still runs an older FULI and should be restarted.
const directory = runtimeConfigPath => join(dirname(runtimeConfigPath), 'mcp-processes');

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
export function registerMcpProcess(runtimeConfigPath, { sourceApplication, version, pid = process.pid }) {
  const path = join(directory(runtimeConfigPath), `${pid}.json`);
  const record = { pid, version, sourceApplication: sourceApplication ?? null, startedAt: new Date().toISOString(), sessionIds: [] };
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

// Every live server's record ({ pid, version, sourceApplication, startedAt, sessionIds });
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

// Live servers of this client that run a different version.
export function outdatedMcpProcesses(runtimeConfigPath, { sourceApplication, version, isAlive = alive }) {
  return liveMcpProcesses(runtimeConfigPath, { isAlive })
    .filter(record => record.sourceApplication === sourceApplication && record.version !== version);
}

// The one-time notice for this session, or null. Shown again only when the
// set of outdated versions changes.
export function outdatedMcpNotice(runtimeConfigPath, { sourceApplication, version, sessionId, isAlive = alive }) {
  const outdated = outdatedMcpProcesses(runtimeConfigPath, { sourceApplication, version, isAlive });
  if (!outdated.length || typeof sessionId !== 'string') return null;
  const versions = [...new Set(outdated.map(record => record.version))].sort();
  const marker = join(directory(runtimeConfigPath), `noticed-${createHash('sha256')
    .update(JSON.stringify([sourceApplication, sessionId, versions])).digest('hex').slice(0, 24)}`);
  try { writeFileSync(marker, '', { flag: 'wx' }); } catch { return null; }
  return `FULI ${version} is installed, but ${outdated.length} open ${sourceApplication} session(s) still run FULI ${versions.join(', ')}. `
    + 'Restart those sessions to load it (it uses fewer tokens). / 已安装 FULI ' + version + '，但有 ' + outdated.length
    + ' 个打开的会话还在用旧版 ' + versions.join('、') + '，重启这些会话即可加载新版（更省 Token）。';
}

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
