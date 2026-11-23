import { STAGE_MARKER_ENV } from './startup-stage.js';

// Why a start did not finish, for the failures a person can do something
// about. Each one is two parts: what happened, and the next step. The error a
// start throws carries the code and the facts (startupFailure); each surface
// words the next step its own way — the terminal names a command, the desktop
// window a button — so neither tells the other's person to do the wrong thing.
//
// A failure with no code here keeps its own message, as before.

const FAILURES = Object.freeze({
  // A Neo4j lifecycle lock nobody released (neo4j-asset-state.js). One whose
  // recorded holder has ended is taken over before it gets here.
  native_lifecycle_lock: {
    what: f => [
      `数据库维护锁从 ${clock(f.since)} 起一直没放开（${f.holderRunning ? `进程 ${f.pid} 还在用它` : '没有记录是谁加的'}），这次没有启动任何东西。`,
      `A database maintenance lock has been held since ${f.since} (${f.holderRunning ? `process ${f.pid} still holds it` : 'with no record of who took it'}); nothing was started.`],
    next: f => f.holderRunning
      ? [`等进程 ${f.pid} 结束后再启动。`, `Start again once process ${f.pid} has ended.`]
      : [`确认没有 FULI 正在更新或迁移数据库后，删掉 ${f.lockPath} 再启动。`,
        `Make sure no FULI is updating or moving the database, then remove ${f.lockPath} and start again.`]
  },
  // A graph port held by a process FULI's own record does not name (macos-ports.js).
  port_taken: {
    what: f => [
      `端口 ${f.port} 被另一个程序占着（进程 ${f.pid}${f.command ? ` · ${f.command}` : ''}${f.runningSeconds ? `，已运行 ${span(f.runningSeconds, 'zh')}` : ''}），FULI 的记录里没有它，所以没有动它。`,
      `Port ${f.port} is held by another program (process ${f.pid}${f.command ? ` · ${f.command}` : ''}${f.runningSeconds ? `, running for ${span(f.runningSeconds, 'en')}` : ''}); FULI's record does not name it, so it was left alone.`],
    next: f => [`如果它是之前没停干净的 FULI 图数据库，结束进程 ${f.pid} 后再启动；否则先关掉占用它的程序。`,
      `If it is a FULI graph database that did not stop cleanly, end process ${f.pid} and start again; otherwise close the program that holds the port.`]
  },
  console_not_answering: {
    what: f => [`控制台 ${f.seconds} 秒内没有应答，已经停掉它。图数据库和 Provider 还在运行，数据都在。`,
      `The console did not answer within ${f.seconds} s and was stopped. The graph database and the Provider are still running, and your data is kept.`],
    next: retryOrStop
  },
  console_exited: {
    what: () => ['控制台启动时退出了。图数据库和 Provider 还在运行，数据都在。',
      'The console exited while starting. The graph database and the Provider are still running, and your data is kept.'],
    next: retryOrStop
  },
  provider_not_ready: {
    what: () => ['Provider 启动后一直没有就绪。', 'The Provider started but never became ready.'],
    next: retry
  },
  provider_exited: {
    what: () => ['Provider 在启动时退出了。', 'The Provider exited while starting.'],
    next: retry
  }
});

function retry(f) {
  return [`再运行一次同样的命令重试。启动日志在 ${f.logPath}。`, `Run the same command again to retry. The start's log is in ${f.logPath}.`];
}

function retryOrStop(f) {
  return [`再运行一次同样的命令重试，或运行 fuli stop 停掉图服务。控制台的输出在 ${f.logPath}。`,
    `Run the same command again to retry, or run \`fuli stop\` to stop the graph services. The console's output is in ${f.logPath}.`];
}

// The failure an error stands for: { code, …facts } with plain data only, or
// null when it is none of these. [logPath] fills in where the start's log is
// when the error itself does not say.
export function startupFailureOf(error, { logPath = null } = {}) {
  const code = error?.startupFailure?.code ?? error?.code;
  if (!Object.hasOwn(FAILURES, code)) return null;
  return { logPath, ...(error.startupFailure ?? {}), code };
}

// The two parts in both languages, as the terminal prints them.
export function formatStartupFailure(failure) {
  const { what, next } = FAILURES[failure.code];
  const [whatZh, whatEn] = what(failure), [nextZh, nextEn] = next(failure);
  return `没有启动：${whatZh}\n下一步：${nextZh}\nFULI did not start: ${whatEn}\nNext: ${nextEn}`;
}

// A client reading along (FULI_STAGE_MARKERS=1) gets the failure as one JSON
// line it can render its own way; a result line carries `ok`, this one never does.
export function startupFailureMarker(failure) {
  return JSON.stringify({ failure });
}

export function readStartupFailureMarker(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Object.hasOwn(value, 'ok')) return null;
  return Object.hasOwn(FAILURES, value.failure?.code) ? value.failure : null;
}

// Runs a start; a failure it knows is printed as what happened and the next
// step instead of a bare message, and also as a marker line for a client.
export async function reportingStartupFailure(run, { write, env = process.env, logPath = null }) {
  try {
    return await run();
  } catch (error) {
    const failure = startupFailureOf(error, { logPath });
    if (!failure) throw error;
    if (env?.[STAGE_MARKER_ENV] === '1') write(startupFailureMarker(failure));
    throw Object.assign(new Error(formatStartupFailure(failure), { cause: error }), { startupFailure: failure });
  }
}

// "2026-11-23 01:24" in the machine's own time.
function clock(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso);
  const pad = value => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function span(seconds, language) {
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (language === 'zh') return days ? `${days} 天` : hours ? `${hours} 小时` : minutes ? `${minutes} 分钟` : `${seconds} 秒`;
  return days ? `${days} d` : hours ? `${hours} h` : minutes ? `${minutes} min` : `${seconds} s`;
}

export const STARTUP_FAILURE_CODES = Object.freeze(Object.keys(FAILURES));
