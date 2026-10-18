import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Every stdio MCP server records its version beside the runtime config. An
// update does not restart servers that clients already started, so a hook
// (always the installed version) can tell the person once per session that an
// open client still runs an older FULI and should be restarted.
const directory = runtimeConfigPath => join(dirname(runtimeConfigPath), 'mcp-processes');

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

export function registerMcpProcess(runtimeConfigPath, { sourceApplication, version, pid = process.pid }) {
  const path = join(directory(runtimeConfigPath), `${pid}.json`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid, version, sourceApplication: sourceApplication ?? null, startedAt: new Date().toISOString() }));
  } catch { return () => {}; }
  return () => { try { rmSync(path, { force: true }); } catch { /* best effort */ } };
}

// Live servers of this client that run a different version; files of exited
// processes are removed on the way.
export function outdatedMcpProcesses(runtimeConfigPath, { sourceApplication, version, isAlive = alive }) {
  let names;
  try { names = readdirSync(directory(runtimeConfigPath)); } catch { return []; }
  const outdated = [];
  for (const name of names.filter(item => /^\d+\.json$/.test(item))) {
    const path = join(directory(runtimeConfigPath), name);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (!isAlive(record.pid)) { rmSync(path, { force: true }); continue; }
      if (record.sourceApplication === sourceApplication && record.version !== version) outdated.push(record);
    } catch { /* unreadable entry: skip */ }
  }
  return outdated;
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
