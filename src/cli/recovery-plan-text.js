import { basename, dirname, join } from 'node:path';

import { byteSize } from '../text/byte-size.js';
import { localClockTime } from '../text/clock-time.js';

// What `fuli graph runtime recover` says it will do, and why it will not, in
// both languages (src/native-runtime/neo4j-recovery.js plans it). The desktop
// client words the same plan its own way (strings.dart `recoveryPlanWords`).

const RECOVER = 'fuli graph runtime recover';

const KIND = {
  undo_switch: ['撤销一次没做完的数据库切换：新版本还没生效，回到切换前的状态。', 'Undo a database switch that did not finish: the newer version never took effect, so go back to before it.'],
  finish_switch: ['完成一次没做完的数据库切换：新版本已经生效；先确认它能启动、存储格式没变，再保留它。',
    'Finish a database switch that did not finish: the newer version already took effect; it is kept once it starts and the store format is unchanged.'],
  back_out_switch: ['撤回一次没做完的数据库切换：回到切换前的版本；先确认存储格式没变、旧版本能启动，不行就保持新版本。',
    'Back out a database switch that did not finish: return to the older version, once the store format is unchanged and the older version starts; otherwise the newer one stays.'],
  finish_uninstall: ['完成一次没做完的数据库卸载：剩下的数据库程序移到 recovered 文件夹，知识数据不动。', 'Finish a database uninstall that did not finish: the remaining database programs move to the recovered folder; knowledge data is not touched.'],
  clear_interrupted: ['清理一次中途停下的数据库操作：它停在改动数据之前，把装了一半的东西放到一边。', 'Clear up a database operation that stopped part way, before it changed any data: set aside what it half installed.'],
  release_dump: ['解除一次中途停下的导出留下的锁：导出只读数据库。', 'Release the lock an interrupted dump left: a dump only reads the database.'],
  restore_load: ['把一次中途停下的导入撤回到导入前：导入可能只写了一半。这次想导入的内容不会保留，之后需要重新导入。',
    'Take an interrupted import back to before it: it may be half written. What it was importing is not kept; import it again afterwards.']
};

function stepWords(step) {
  const size = step.bytes === undefined ? ['', ''] : [`，${byteSize(step.bytes)}`, `, ${byteSize(step.bytes)}`];
  switch (step.do) {
    case 'stop-services': return ['停止 FULI 记录的图数据库和 Provider 进程', 'Stop the graph database and Provider processes FULI recorded'];
    case 'check-start': return [`用 Neo4j ${step.version} 启动一次，确认它能应答，再停下${step.revert ? '（不行就写回新版本的描述文件）' : ''}`,
      `Start Neo4j ${step.version} once, check it answers, and stop it${step.revert ? ' (if it does not, the newer descriptor is written back)' : ''}`];
    case 'check-formats': return ['确认存储格式和切换前一样', 'Check the store format is still the one from before the switch'];
    case 'check-fingerprint': return ['确认旧版本的数据库程序没有变', 'Check the older database programs did not change'];
    case 'write-manifest': return ['写回数据库描述文件 manifest.json（原来的先复制到 recovered 文件夹）', 'Write the database descriptor manifest.json (the one there is first copied to the recovered folder)'];
    case 'move-aside': return [`把${what(step.path)[0]}（${step.path}${size[0]}）移到 native-runtime/recovered/，不删除`,
      `Move ${what(step.path)[1]} (${step.path}${size[1]}) to native-runtime/recovered/, not deleted`];
    case 'rename': return [`把没写完的备份改名为 ${basename(step.to)}`, `Rename the unfinished backup to ${basename(step.to)}`];
    case 'archive-journal': return ['把切换记录 neo4j-transaction.json 移到 native-runtime/recovered/', 'Move the switch journal neo4j-transaction.json to native-runtime/recovered/'];
    case 'restore': return [`从 ${step.from} 整库导入（${step.instances.join('、')}）`, `Import the whole graph from ${step.from} (${step.instances.join(', ')})`];
    case 'prune': return [`清理 ${step.path}${size[0]}（超过 30 天、且之后又有 3 次恢复的旧恢复文件夹）`,
      `Clear ${step.path}${size[1]} (an old recovery folder: over 30 days old, with 3 newer recoveries)`];
    case 'release-lock': return ['解除数据库维护锁', 'Release the database maintenance lock'];
    default: return [step.do, step.do];
  }
}

// What a moved directory is, in words.
function what(path) {
  if (/[\\/]data[\\/]databases[\\/]neo4j$/.test(path)) return ['导入前是空的、被写了一半的图数据库', 'the half-written graph database that was empty before the import'];
  if (/[\\/]data[\\/]transactions[\\/]neo4j$/.test(path)) return ['它的事务日志', 'its transaction logs'];
  if (/[\\/]jvs-a-[^\\/]+$/.test(path)) return ['一份数据库程序', 'a copy of the database programs'];
  if (/[\\/]neo4j-community-[^\\/]+$/.test(path)) return ['数据库程序', 'the database programs'];
  return ['目录', 'the directory'];
}

export function formatRecoveryPlan(plan) {
  if (plan.kind === 'nothing') return '没有要恢复的东西。 / There is nothing to recover.';
  if (plan.kind === 'refused') return `没有恢复：${refusalWords(plan)[0]} / Not recovered: ${refusalWords(plan)[1]}`;
  const [zh, en] = KIND[plan.kind];
  const lines = [zh, en, ...facts(plan), ...plan.steps.map((step, index) => `${index + 1}. ${stepWords(step)[0]} / ${stepWords(step)[1]}`)];
  if (plan.alternative?.kind === 'back_out_switch') {
    lines.push(`也可以撤回到 ${plan.fromVersion}：${RECOVER} --back-out。 / You can also go back to ${plan.fromVersion}: \`${RECOVER} --back-out\`.`);
  } else if (plan.alternative?.kind === 'finish_switch') {
    lines.push(`也可以保留 ${plan.toVersion}：${RECOVER}（不带 --back-out）。 / You can also keep ${plan.toVersion}: \`${RECOVER}\` without --back-out.`);
  } else if (plan.alternativeRefused) {
    const [why, whyEn] = refusalWords({ ...plan, reason: plan.alternativeRefused });
    lines.push(`不能撤回到 ${plan.fromVersion}：${why} / Going back to ${plan.fromVersion} is not possible: ${whyEn}`);
  }
  return lines.join('\n');
}

// What the person should know before confirming, beyond the steps.
function facts(plan) {
  const lines = [];
  if (plan.backupPath && ['finish_switch', 'back_out_switch'].includes(plan.kind)) {
    lines.push(`升级前的图备份在 ${plan.backupPath}。 / The graph backup from before the upgrade is at ${plan.backupPath}.`);
  }
  if (plan.kind === 'restore_load') {
    const copy = plan.restorePoint;
    if (copy) {
      const at = localClockTime(copy.createdAt, { date: true }) ?? copy.createdAt;
      lines.push(`用这次导入开始前（${at}）自动留下的备份恢复 ${copy.instances.join('、')}：${copy.path}。 / ${copy.instances.join(', ')} ${copy.instances.length === 1 ? 'goes' : 'go'} back to the copy this import took before it started (${at}): ${copy.path}.`);
    }
    if (plan.emptied?.length) {
      lines.push(`${plan.emptied.join('、')} 在导入前是空的，恢复后也是空的。 / ${plan.emptied.join(', ')} ${plan.emptied.length === 1 ? 'was' : 'were'} empty before the import and will be empty again.`);
    }
  }
  return lines;
}

// Once it is done: where its record is.
export function recoveredLine(result) {
  const record = result.record ? ` 做了什么记在 ${result.record}。 / What it did is recorded in ${result.record}.` : '';
  return `已恢复，可以启动 FULI 了。 / Recovered; FULI can start now.${record}`;
}

function refusalWords(plan) {
  const recovered = plan.path ? join(dirname(dirname(plan.path)), 'recovered') : 'native-runtime/recovered';
  const record = plan.record ? `做了的步骤记在 ${plan.record}。` : '';
  const recordEn = plan.record ? ` The steps done are recorded in ${plan.record}.` : '';
  const backup = plan.backupPath ? `升级前的图备份在 ${plan.backupPath}。` : '';
  const backupEn = plan.backupPath ? ` The graph backup from before the upgrade is at ${plan.backupPath}.` : '';
  const look = ['数据库维护锁和切换记录都留着，FULI 不再往下做；需要人来看，可以把 fuli diagnostics 的输出交给帮你看的人。',
    'The maintenance lock and the switch journal stay and FULI goes no further; a person needs to look, and the output of `fuli diagnostics` helps whoever does.'];
  return ({
    holder_running: [`进程 ${plan.pid} 还在用数据库维护锁。等它结束后再运行 ${RECOVER}。`, `Process ${plan.pid} still holds the maintenance lock. Run \`${RECOVER}\` again once it ends.`],
    fuli_running: [`另一个 FULI 命令（进程 ${plan.pid}）正在用这份数据。等它结束后再运行 ${RECOVER}。`, `Another FULI command (process ${plan.pid}) is using this data. Run \`${RECOVER}\` again once it ends.`],
    cannot_inspect: [`看不到正在运行的程序，没法确认没人在用。稍后再运行 ${RECOVER}。`, `The running programs could not be listed, so nobody using it could be ruled out. Run \`${RECOVER}\` again later.`],
    no_holder: ['这把锁没有记录是谁加的。用 fuli graph runtime unlock 解除它，它会先做同样的检查。', 'This lock records no holder. Release it with `fuli graph runtime unlock`, which makes the same checks first.'],
    too_recent: [`这把锁没有记录是谁加的，加上还不到 90 分钟，可能还有人在用。${localClockTime(plan.releasableAt, { date: true }) ?? plan.releasableAt} 之后再运行 ${RECOVER}。`,
      `This lock records no holder and is less than 90 minutes old, so it may still be in use. Run \`${RECOVER}\` again after ${plan.releasableAt}.`],
    cannot_stop_services: [`图服务（进程 ${plan.pid}）还在运行，又没有锁的令牌能停它。先结束它：kill ${plan.pid}，再运行 ${RECOVER}。`,
      `A graph service (process ${plan.pid}) still runs and there is no lock token to stop it with. End it first: \`kill ${plan.pid}\`, then run \`${RECOVER}\` again.`],
    manifest_changed: [`数据库描述文件 manifest.json 既不是操作前也不是操作后的样子，可能有人改过或重装过。${look[0]}`,
      `The database descriptor manifest.json is neither the one from before nor after the operation; it may have been changed or reinstalled. ${look[1]}`],
    unknown_journal: [`切换记录 neo4j-transaction.json 是空的、坏了或看不懂。${look[0]}`, `The switch journal neo4j-transaction.json is empty, damaged or unreadable. ${look[1]}`],
    unmanaged_path: [`记录里的数据库程序目录不在 FULI 管理的位置，FULI 不动它。${look[0]}`, `The records name database programs outside the places FULI manages, so FULI leaves them alone. ${look[1]}`],
    assets_changed: [`数据库程序在操作中途被改过。${look[0]}`, `The database programs changed during the operation. ${look[1]}`],
    unknown_assets: [`neo4j-assets 里有一个认不出的目录（${plan.directory}）：名字像 FULI 的，但里面没有 FULI 的记录，可能是一次更新在写记录前就停了，也可能是别的东西。FULI 没有动它。看过确认不需要后，把它移开（不要删除）：mv "${plan.path}" "${recovered}/"，再运行 ${RECOVER}。`,
      `neo4j-assets holds a directory FULI cannot recognise (${plan.directory}): its name looks like FULI's but it carries no FULI record; an update may have stopped before writing one, or it is something else. FULI left it alone. Once you are sure it is not needed, move it away (do not delete it): \`mv "${plan.path}" "${recovered}/"\`, then run \`${RECOVER}\` again.`],
    no_fingerprint: [`切换记录里没有旧版本程序的指纹，没法确认旧版本完好，所以不能撤回；只能完成切换：${RECOVER}。`,
      `The switch journal has no fingerprint of the older programs, so they cannot be checked and backing out is not possible; it can only be finished: \`${RECOVER}\`.`],
    format_changed: [`存储格式和切换前记下的不一样，继续不安全。${backup}${look[0]}`, `The store format is not the one recorded before the switch, so going on is unsafe.${backupEn} ${look[1]}`],
    format_unreadable: [`读不出存储格式（数据库可能还在运行，或需要先自行恢复）。锁和记录都留着，稍后再运行 ${RECOVER}。`,
      `The store format could not be read (the database may still run, or need its own recovery). The lock and journal stay; run \`${RECOVER}\` again later.`],
    start_failed: [`这个版本的数据库没能启动或没有应答，描述文件已经保持原样，锁和记录都留着。可以换另一种做法（完成或撤回），或稍后再试。${backup}${record}`,
      `That database version did not start or did not answer; the descriptor was left as it was, and the lock and journal stay. Try the other choice (finish or back out), or try again later.${backupEn}${recordEn}`],
    restore_failed: [`没能从导入前的备份恢复，锁留着，启动会被挡住。再运行一次 ${RECOVER} 会接着做；还不行就需要人来看。${record}`,
      `Restoring from the copy taken before the import did not finish; the lock stays, so nothing starts on a half-written graph. Running \`${RECOVER}\` again continues it; if it fails again, a person needs to look.${recordEn}`],
    restore_point_unknown: ['这次导入没有记下它在导入前留的是哪一份备份，FULI 不猜。导入前的备份都在 FULI 数据文件夹的 backups/graph 里（before-import-*）；需要人来看。',
      'This import did not record which copy it took before it started, and FULI does not guess. The copies are in backups/graph in the FULI data folder (before-import-*); a person needs to look.'],
    restore_point_damaged: [`这次导入在导入前留下的备份（${plan.backupPath}）不见了或不完整，FULI 不改用别的备份。需要人来看。`,
      `The copy this import took before it started (${plan.backupPath}) is missing or incomplete, and FULI does not use another one instead. A person needs to look.`],
    lock_changed: [`解除锁的时候锁变了。再运行一次 ${RECOVER}。`, `The lock changed while it was being released. Run \`${RECOVER}\` again.`],
    step_failed: [`在“${plan.step}”这一步停下了，锁留着。再运行一次 ${RECOVER} 会接着做。${record}`, `It stopped at the step "${plan.step}" and the lock stays. Running \`${RECOVER}\` again continues it.${recordEn}`],
    plan_changed: [`情况在你确认之后变了，什么都没做；再运行 ${RECOVER} 看新的计划。`, `Things changed after you confirmed, so nothing was done; run \`${RECOVER}\` again to see the new plan.`],
    needs_person: ['恢复只在你自己敲命令的终端里做，或在桌面窗口里点「恢复并启动」；没有终端时只能看计划（--preview）。',
      'A recovery runs only in a terminal you type in, or from 「恢复并启动」 in the desktop window; without a terminal only the plan is shown (--preview).']
  })[plan.reason] ?? [String(plan.reason), String(plan.reason)];
}
