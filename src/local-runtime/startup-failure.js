import { localClockTime } from '../text/clock-time.js';

// Why a start did not finish, for the failures a person can do something
// about. Each one is two parts: what happened, and the next step. The error a
// start throws carries the code and the facts (startupFailure); each surface
// words the next step its own way — the terminal names a command, the desktop
// window a button — so neither tells the other's person to do the wrong thing.
//
// A failure with no code here keeps its own message, as before.

const since = f => localClockTime(f.since, { date: true }) ?? f.since;
const UNLOCK = ['运行 fuli graph runtime unlock：它先核对没有 FULI 在用数据库，再解除这把锁。',
  'Run `fuli graph runtime unlock`: it checks that no FULI is using the database, then releases the lock.'];

const FAILURES = Object.freeze({
  // A switch journal waits (neo4j-lifecycle-lock.js): never a reason to remove the lock.
  // FULI has no command that finishes or undoes such a switch: the person is told
  // what state things are in and what not to do (neo4j-lifecycle.js).
  native_recovery_needed: {
    what: f => [`有一次数据库${operationZh(f.operation)}没做完，这次没有启动任何东西。知识数据还在原来的位置，没有被复制或覆盖；如果是一次升级，升级前的图备份留在 FULI 数据文件夹的 graph-backups 里。`,
      `A database ${f.operation ?? 'switch'} did not finish, so nothing was started. Your knowledge data is still where it was and was not copied or overwritten; if it was an upgrade, the graph backup taken before it is in graph-backups in the FULI data folder.`],
    next: () => ['FULI 现在没有能自动完成或撤销这一步的命令，需要人来恢复。在那之前不要删除数据库维护锁或 neo4j-transaction.json，也不要用别的版本的 FULI 打开这份数据。',
      'FULI has no command that finishes or undoes this step yet; a person needs to recover it. Until then, do not remove the maintenance lock or neo4j-transaction.json, and do not open this data with another FULI version.']
  },
  native_lifecycle_lock: {
    what: f => ({
      running: [`数据库维护锁从 ${since(f)} 起被进程 ${f.pid}${f.command ? `（${f.command}）` : ''}占着，这次没有启动任何东西。`,
        `Process ${f.pid}${f.command ? ` (${f.command})` : ''} has held the database maintenance lock since ${since(f)}; nothing was started.`],
      gone: [`一次数据库${operationZh(f.operation)}在 ${since(f)} 中途停了，留下了维护锁；知识数据没有被改动。它可能留下了装了一半的文件，所以 FULI 不会自动解除这把锁。`,
        `A database ${f.operation ?? 'operation'} stopped part way at ${since(f)} and left its maintenance lock; your knowledge data was not changed. It may have left files half installed, so FULI does not release the lock by itself.`],
      unknown: [`数据库维护锁从 ${since(f)} 起一直没放开，没有记录是谁加的，这次没有启动任何东西。`,
        `The database maintenance lock has been held since ${since(f)} with no record of who took it; nothing was started.`]
    })[f.holder],
    next: f => f.holder === 'running'
      ? [`等进程 ${f.pid} 结束后再启动。`, `Start again once process ${f.pid} has ended.`]
      // An asset operation that died before its journal changed no data, but no
      // FULI command clears up after it (the lock also blocks a rerun).
      : f.holder === 'gone'
        ? [`FULI 现在没有能处理这种情况的命令，需要人来处理：先检查 ${f.lockPath ? `${f.lockPath.replace(/\/\.neo4j-lifecycle\.lock$/, '')}/neo4j-assets` : 'native-runtime/neo4j-assets'} 里没装完的目录，再解除这把锁。`,
          `FULI has no command for this case yet; a person needs to handle it: check ${f.lockPath ? `${f.lockPath.replace(/\/\.neo4j-lifecycle\.lock$/, '')}/neo4j-assets` : 'native-runtime/neo4j-assets'} for an unfinished directory, then release the lock.`]
        : UNLOCK
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
    what: f => f.stillRunningPid
      ? [`控制台 ${f.seconds} 秒内没有应答，停它时也没停下来，进程 ${f.stillRunningPid} 可能还在。图数据库和 Provider 还在运行，数据都在。`,
        `The console did not answer within ${f.seconds} s and did not end when stopped; process ${f.stillRunningPid} may still run. The graph database and the Provider still run, and your data is kept.`]
      : [`控制台 ${f.seconds} 秒内没有应答，已经停掉它。图数据库和 Provider 还在运行，数据都在。`,
        `The console did not answer within ${f.seconds} s and was stopped. The graph database and the Provider are still running, and your data is kept.`],
    next: retryOrStop
  },
  console_exited: {
    what: () => ['控制台启动时退出了。图数据库和 Provider 还在运行，数据都在。',
      'The console exited while starting. The graph database and the Provider are still running, and your data is kept.'],
    next: retryOrStop
  },
  // A console port Windows reserves: retrying on it cannot help.
  console_port_reserved: {
    what: f => [`控制台用不了端口 ${f.port}：Windows 保留了它。图数据库和 Provider 还在运行，数据都在。`,
      `The console cannot use port ${f.port}: Windows reserves it. The graph database and the Provider still run, and your data is kept.`],
    next: () => ['换一个端口后再启动（托盘菜单里的「换一个端口」会自动选一个能用的）。',
      'Use another port, then start again (the tray menu\'s Use another port picks one that works).']
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

function operationZh(operation) {
  return { update: '更新', rollback: '回退', uninstall: '卸载', admin: '导出或导入' }[operation] ?? '切换';
}

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
function startupFailureOf(error, { logPath = null } = {}) {
  const code = error?.startupFailure?.code ?? error?.code;
  if (!Object.hasOwn(FAILURES, code)) return null;
  return { logPath, ...(error.startupFailure ?? {}), code };
}

// The two parts in both languages, as the terminal prints them.
function formatStartupFailure(failure) {
  const { what, next } = FAILURES[failure.code];
  const [whatZh, whatEn] = what(failure), [nextZh, nextEn] = next(failure);
  return `没有启动：${whatZh}\n下一步：${nextZh}\nFULI did not start: ${whatEn}\nNext: ${nextEn}`;
}

// Runs a start; a failure it knows is printed as what happened and the next
// step instead of a bare message. The facts go on with the error as its
// startupFailure, which the CLI prints on a line of its own for a desktop
// client (startup-failure-line.js) — without the local paths, which only the
// terminal's sentences use.
export async function reportingStartupFailure(run, { logPath = null } = {}) {
  try {
    return await run();
  } catch (error) {
    const failure = startupFailureOf(error, { logPath });
    if (!failure) throw error;
    const { logPath: _log, lockPath: _lock, journalPath: _journal, ...facts } = failure;
    throw Object.assign(new Error(formatStartupFailure(failure), { cause: error }), { startupFailure: facts });
  }
}

// Why `fuli graph runtime unlock` kept the lock, in both languages.
export function lockReleaseRefusal(result) {
  const reasons = {
    no_lock: ['没有要解除的锁。', 'There is no lock to release.'],
    recovery_needed: ['有一次数据库切换没做完，需要先恢复，锁没有动。', 'A database switch did not finish and needs recovery first; the lock was kept.'],
    asset_operation: [`这把锁是一次数据库${operationZh(result.operation)}留下的，可能留下了装了一半的文件，不能这样解除。`,
      `This lock was left by a database ${result.operation ?? 'operation'}, which may have left files half installed; it cannot be released this way.`],
    holder_running: [`进程 ${result.pid} 还在用这把锁，锁没有动。`, `Process ${result.pid} still holds the lock; it was kept.`],
    services_running: [`FULI 记录的图服务（进程 ${result.pid}）还在运行，锁没有动。`, `A graph service FULI recorded (process ${result.pid}) still runs; the lock was kept.`],
    fuli_running: [`另一个 FULI 命令（进程 ${result.pid}）正在用这份数据，锁没有动。`, `Another FULI command (process ${result.pid}) is using this data; the lock was kept.`],
    cannot_inspect: ['看不到这台电脑上正在运行的程序，没法确认没人在用，锁没有动。', 'The running programs could not be listed, so nobody using it could be ruled out; the lock was kept.'],
    too_recent: [`锁加上不久，一次数据库更新可能还在进行；${localClockTime(result.releasableAt, { date: true })} 之后再试。`,
      `The lock is recent and a database update may still be running; try again after ${result.releasableAt}.`],
    changed: ['锁在核对时被换掉了，没有动它。', 'The lock changed while it was being checked; it was kept.']
  }[result.reason] ?? [`锁没有动（${result.reason}）。`, `The lock was kept (${result.reason}).`];
  return `${reasons[0]} / ${reasons[1]}`;
}

function span(seconds, language) {
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (language === 'zh') return days ? `${days} 天` : hours ? `${hours} 小时` : minutes ? `${minutes} 分钟` : `${seconds} 秒`;
  return days ? `${days} d` : hours ? `${hours} h` : minutes ? `${minutes} min` : `${seconds} s`;
}
