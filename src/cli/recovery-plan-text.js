import { basename } from 'node:path';

// What `fuli graph runtime recover` says it will do, and why it will not, in
// both languages (src/native-runtime/neo4j-recovery.js plans it). The desktop
// client words the same plan its own way (strings.dart `recoveryPlan`).

const KIND = {
  undo_switch: ['撤销一次没做完的数据库切换：新版本还没生效，回到切换前的状态。', 'Undo a database switch that did not finish: the newer version never took effect, so go back to before it.'],
  finish_switch: ['完成一次没做完的数据库切换：新版本已经生效，保留它。', 'Finish a database switch that did not finish: the newer version already took effect, so keep it.'],
  back_out_switch: ['撤回一次没做完的数据库切换：存储格式没变，回到切换前的版本。', 'Back out a database switch that did not finish: the store format did not change, so return to the older version.'],
  finish_uninstall: ['完成一次没做完的数据库卸载：删掉剩下的数据库程序文件，知识数据不动。', 'Finish a database uninstall that did not finish: remove the remaining database programs; knowledge data is not touched.'],
  clear_interrupted: ['清理一次中途停下的数据库操作：它停在改动数据之前，把装了一半的东西放到一边。', 'Clear up a database operation that stopped part way, before it changed any data: set aside what it half installed.'],
  release_dump: ['解除一次中途停下的导出留下的锁：导出只读数据库。', 'Release the lock an interrupted dump left: a dump only reads the database.'],
  restore_load: ['从导入前自动留下的备份整库恢复：中途停下的导入可能只写了一半。', 'Restore the whole graph from the copy the import took first: the interrupted load may be half written.']
};

function stepWords(step) {
  switch (step.do) {
    case 'stop-services': return ['停止 FULI 记录的图数据库和 Provider 进程', 'Stop the graph database and Provider processes FULI recorded'];
    case 'check-formats': return ['确认存储格式和切换前一样', 'Check the store format is still the one before the switch'];
    case 'check-fingerprint': return ['确认旧版本的数据库程序没有变', 'Check the older database programs did not change'];
    case 'write-manifest': return ['写回数据库描述文件 manifest.json', 'Write the database descriptor manifest.json back'];
    case 'move-aside': return [`把 ${basename(step.path)} 移到 native-runtime/recovered/（不删）`, `Move ${basename(step.path)} to native-runtime/recovered/ (not deleted)`];
    case 'rename': return [`把没写完的备份改名为 ${basename(step.to)}`, `Rename the unfinished backup to ${basename(step.to)}`];
    case 'remove': return [`删除数据库程序文件 ${step.path}`, `Delete the database programs in ${step.path}`];
    case 'archive-journal': return ['把切换记录 neo4j-transaction.json 移到 native-runtime/recovered/', 'Move the switch journal neo4j-transaction.json to native-runtime/recovered/'];
    case 'release-lock': return ['解除数据库维护锁', 'Release the database maintenance lock'];
    case 'restore': return [`从 ${step.from} 整库导入`, `Import the whole graph from ${step.from}`];
    default: return [step.do, step.do];
  }
}

export function formatRecoveryPlan(plan) {
  if (plan.kind === 'nothing') return '没有要恢复的东西。 / There is nothing to recover.';
  if (plan.kind === 'refused') return `没有恢复：${refusalWords(plan)[0]} / Not recovered: ${refusalWords(plan)[1]}`;
  const [zh, en] = KIND[plan.kind];
  const lines = [zh, en, ...plan.steps.map((step, index) => `${index + 1}. ${stepWords(step)[0]} / ${stepWords(step)[1]}`)];
  if (plan.backupPath && plan.kind === 'finish_switch') lines.push(`升级前的图备份在 ${plan.backupPath}。 / The graph backup from before the upgrade is at ${plan.backupPath}.`);
  return lines.join('\n');
}

function refusalWords(plan) {
  return ({
    holder_running: [`进程 ${plan.pid} 还在用数据库维护锁。`, `Process ${plan.pid} still holds the maintenance lock.`],
    fuli_running: [`另一个 FULI 命令（进程 ${plan.pid}）正在用这份数据。`, `Another FULI command (process ${plan.pid}) is using this data.`],
    cannot_inspect: ['看不到正在运行的程序，没法确认没人在用。', 'The running programs could not be listed, so nobody using it could be ruled out.'],
    no_holder: ['这把锁没有记录是谁加的；用 fuli graph runtime unlock 解除。', 'This lock records no holder; release it with `fuli graph runtime unlock`.'],
    cannot_stop_services: [`图服务（进程 ${plan.pid}）还在运行，又没有锁的令牌能停它。`, `A graph service (process ${plan.pid}) still runs and there is no lock token to stop it with.`],
    manifest_changed: ['数据库描述文件既不是切换前也不是切换后的样子，需要人来看。', 'The database descriptor is neither the one before nor after the switch; a person needs to look at it.'],
    unknown_journal: ['切换记录看不懂，需要人来看。', 'The switch journal cannot be read; a person needs to look at it.'],
    assets_changed: ['数据库程序在操作中途被改过，需要人来看。', 'The database programs changed during the operation; a person needs to look at them.'],
    unknown_assets: [`neo4j-assets 里有不是 FULI 放的目录（${plan.directory}），没有动它。`, `neo4j-assets holds a directory FULI did not make (${plan.directory}); it was left alone.`],
    no_restore_point: ['导入前没有留下备份（数据库原来是空的，或备份不完整）。用原来的导出重新导入：先删掉数据库维护锁，再运行 fuli graph import --input <导出目录> --yes。',
      'The import left no copy from before it (the database was empty, or the copy is incomplete). Import the original export again: remove the maintenance lock, then run `fuli graph import --input <export folder> --yes`.'],
    plan_changed: ['情况在你确认之后变了，什么都没做；重新看一遍计划。', 'Things changed after you confirmed, so nothing was done; review the plan again.']
  })[plan.reason] ?? [plan.reason, plan.reason];
}
