import { basename, dirname, join } from 'node:path';

import { byteSize } from '../text/byte-size.js';
import { localClockTime } from '../text/clock-time.js';

// What `fuli graph runtime recover` says it will do, and why it will not, in
// both languages (src/native-runtime/neo4j-recovery.js plans it). The desktop
// client words the same plan its own way (strings.dart `recoveryPlanWords`).

const RECOVER = 'fuli graph runtime recover';
const ABANDON = `${RECOVER} --abandon-import`;
const KEEP_NEWER = `${RECOVER} --keep-newer`;

// The commands a person types by hand: a POSIX shell, or PowerShell on
// Windows, where Windows PowerShell 5.1 has neither `&&` nor `mkdir -p`, and
// stops several processes only as one comma-separated list. (Its `mv` alias
// moves "from" to "to" as the POSIX one does, so those lines stay as they are.)
export function moveIntoCommand(folder, path, platform = process.platform) {
  return platform === 'win32'
    ? `New-Item -ItemType Directory -Force -Path "${folder}" | Out-Null; Move-Item -LiteralPath "${path}" -Destination "${folder}"`
    : `mkdir -p "${folder}" && mv "${path}" "${folder}/"`;
}

export function killCommand(pids, platform = process.platform) {
  return platform === 'win32' ? `Stop-Process -Id ${pids.join(',')}` : `kill ${pids.join(' ')}`;
}

// An unfinished update or rollback is worded by what it was and the versions
// on each side (neo4j-recovery.js fromVersion / toVersion), never "newer" and
// "older": a rollback switches to the kept older programs, so its target is
// the older one. With the same number on both sides (a rollback to the
// programs kept from before the update), each side says which copy of the
// programs it is and when it was installed (fromInstalledAt / toInstalledAt);
// only when that time is unknown, which copy it is and its directory (fromLabel / toLabel).
function switchWords(plan) {
  const [verb, verbEn] = { update: ['更新', 'update'], rollback: ['回退', 'rollback'] }[plan.operation] ?? ['切换', 'switch'];
  const side = (version, label, installedAt, [zh, en]) => {
    const at = installedAt ? localClockTime(installedAt, { date: true }) ?? installedAt : null;
    if (at) return [`${version}（${zh}，安装于 ${at}）`, `${version} (${en}, installed ${at})`];
    if (label && label !== version) return [`${version}（${zh}，${label}）`, `${version} (${en}, ${label})`];
    return [version ?? '?', version ?? '?'];
  };
  const roles = plan.operation === 'rollback'
    ? [['回退前在用的那一份程序', 'the programs in use before the rollback'], ['更新前保留的那一份程序', 'the programs kept from before the update']]
    : [['更新前在用的那一份程序', 'the programs in use before the update'], ['这次更新装的那一份程序', 'the programs this update installed']];
  const [from, fromEn] = side(plan.fromVersion, plan.fromLabel, plan.fromInstalledAt, roles[0]);
  const [to, toEn] = side(plan.toVersion, plan.toLabel, plan.toInstalledAt, roles[1]);
  return { verb, verbEn, from, to, fromEn, toEn };
}

function kindWords(plan) {
  const { verb, verbEn, from, to, fromEn, toEn } = switchWords(plan);
  switch (plan.kind) {
    case 'undo_switch': return [`取消这次没做完的${verb}，留在 ${from}：${to} 还没有生效，回到${verb}前的状态。`,
      `Cancel the unfinished ${verbEn} and stay on ${fromEn}: ${toEn} never took effect, so go back to before the ${verbEn}.`];
    case 'finish_switch': return [`完成这次没做完的${verb}，改用 ${to}：${to} 已经生效；先确认它能启动、存储格式没变，再保留它。`,
      `Finish the unfinished ${verbEn} to ${toEn}: ${toEn} already took effect; it is kept once it starts and the store format is unchanged.`];
    case 'back_out_switch': return [`取消这次没做完的${verb}，留在 ${from}：先确认存储格式没变、${from} 能启动；${from} 起不来就写回 ${to}。`,
      `Cancel the unfinished ${verbEn} and stay on ${fromEn}: once the store format is unchanged and ${fromEn} starts; if it does not, ${toEn} is written back.`];
    case 'continue_back_out': return plan.steps.some(step => step.do === 'check-start')
      ? [`接着取消中途停下的${verb}，留在 ${from}：描述文件已经写回 ${from}，但 ${to} 之前已经打开过这个库；先确认 ${from} 还能启动，不行就写回 ${to}。`,
        `Continue cancelling the ${verbEn} that stopped part way, staying on ${fromEn}: the descriptor is ${fromEn}'s again, but ${toEn} had already opened the store; ${fromEn} must start on it, otherwise ${toEn} is written back.`]
      : [`接着取消中途停下的${verb}，留在 ${from}：${from} 已经确认能启动，只剩收尾。`,
        `Continue cancelling the ${verbEn} that stopped part way, staying on ${fromEn}: ${fromEn} already started on the store; only the last steps are left.`];
    case 'keep_newer': return [`完成这次没做完的${verb}，留在 ${to}，并解除这把锁：不再做启动检查，切换记录移到 recovered 文件夹，解除数据库维护锁。之后起不来按普通的启动失败处理。这样做之后，不能再取消这次${verb}回到 ${from}。`,
      `Finish the unfinished ${verbEn} on ${toEn} and release the lock: no start check; the switch journal moves to the recovered folder and the maintenance lock is released. A start that fails afterwards is an ordinary failed start. After this, the ${verbEn} can no longer be cancelled back to ${fromEn}.`];
    default: return KIND[plan.kind] ?? [plan.kind, plan.kind];
  }
}

const KIND = {
  finish_uninstall: ['完成一次没做完的数据库卸载：剩下的数据库程序移到 recovered 文件夹，知识数据不动。', 'Finish a database uninstall that did not finish: the remaining database programs move to the recovered folder; knowledge data is not touched.'],
  clear_interrupted: ['清理一次中途停下的数据库操作：它停在改动数据之前，把装了一半的东西放到一边。', 'Clear up a database operation that stopped part way, before it changed any data: set aside what it half installed.'],
  release_dump: ['解除一次中途停下的导出留下的锁：导出只读数据库。', 'Release the lock an interrupted dump left: a dump only reads the database.'],
  finish_load: ['做完一次已经成功的导入：每个图谱都已完整写入新数据、图谱身份也核对过了，只是在解除锁之前停了。不撤回这次导入，只做一次启动检查再解除锁。',
    'Finish an import that succeeded: every graph holds all of its new data and the graph identity was reconciled; it stopped just before releasing its lock. The import is not taken back: only a start check, then the lock is released.'],
  finish_recovery: ['做完一次中途停下的恢复：它的步骤都做完了，只剩解除它加的锁。', 'Finish a recovery that stopped part way: its steps are done, only the lock it took is left.'],
  restore_load: ['把一次中途停下的导入撤回到导入前：导入可能只写了一半。这次想导入的内容不会保留，之后需要重新导入。',
    'Take an interrupted import back to before it: it may be half written. What it was importing is not kept; import it again afterwards.'],
  abandon_load: ['放弃一次中途停下的导入：不再把图撤回到导入前。只把可能写了一半的图谱挪开（它会变成空的），其余图谱原地不动；每个图谱现在是什么样，下面逐个说明。确认之后，再运行恢复只会接着把放弃做完，不会再自动导回；想回到导入前，请用下面列出的导回命令。',
    'Abandon an interrupted import: the graph does not go back to before it. Only a graph that may be half written moves aside (it becomes empty); the others stay as they are, and what each one now holds is said below. Once you confirm, running the recovery again only finishes abandoning and never brings the copy back by itself; to go back to before the import, use an import command listed below.']
};

function stepWords(step, plan) {
  const { verb, verbEn, from, to, fromEn, toEn } = switchWords(plan);
  const size = step.bytes === undefined ? ['', ''] : [`，${byteSize(step.bytes)}`, `, ${byteSize(step.bytes)}`];
  // In a switch, the side it starts (the one going back starts the side it stays on).
  const [version, versionEn] = plan.fromLabel ? (step.revert ? [from, fromEn] : [to, toEn]) : [step.version, step.version];
  switch (step.do) {
    case 'stop-services': return ['停止 FULI 记录的图数据库和 Provider 进程', 'Stop the graph database and Provider processes FULI recorded'];
    case 'check-start': return [`用 Neo4j${version ? ` ${version}` : ''} 启动一次，确认它能应答，再停下${step.revert ? `（不行就写回 ${to} 的描述文件）` : ''}${step.afterRestore ? '（图已经导回，起不来也照样解除锁，并写明起不来的原因）' : ''}${step.afterImport ? '（图谱已经是完整的新数据，起不来也照样解除锁，并写明起不来的原因）' : ''}`,
      `Start Neo4j${version ? ` ${versionEn}` : ''} once, check it answers, and stop it${step.revert ? ` (if it does not, ${toEn}'s descriptor is written back)` : ''}${step.afterRestore ? ' (the graph is already back, so the lock is released even if it does not start, and why is said)' : ''}${step.afterImport ? ' (every graph already holds the new data, so the lock is released even if it does not start, and why is said)' : ''}`];
    case 'mark-restored': return ['在锁里记下「已导回」：之后重跑不会再导一遍', 'Record in the lock that the graph is back, so running again does not import it again'];
    case 'mark-backing-out': return [`在切换记录里记下「正在取消${verb}」`, `Record in the switch journal that the ${verbEn} is being cancelled`];
    case 'mark-abandoning': return ['在锁里记下每个图谱怎么处理：中途停下再运行，会照同样的判断做完', 'Record in the lock what happens to each graph, so a run that stops part way finishes it the same way'];
    case 'check-formats': return ['确认存储格式和切换前一样', 'Check the store format is still the one from before the switch'];
    case 'check-fingerprint': return [`确认 ${from} 的数据库程序没有变`, `Check ${fromEn}'s database programs did not change`];
    case 'write-manifest': return ['写回数据库描述文件 manifest.json（原来的先复制到 recovered 文件夹）', 'Write the database descriptor manifest.json (the one there is first copied to the recovered folder)'];
    case 'move-aside': return [`把${what(step.path)[0]}（${step.path}${size[0]}）移到 native-runtime/recovered/，不删除`,
      `Move ${what(step.path)[1]} (${step.path}${size[1]}) to native-runtime/recovered/, not deleted`];
    case 'rename': return [`把没写完的备份改名为 ${basename(step.to)}`, `Rename the unfinished backup to ${basename(step.to)}`];
    case 'archive-journal': return ['把切换记录 neo4j-transaction.json 移到 native-runtime/recovered/', 'Move the switch journal neo4j-transaction.json to native-runtime/recovered/'];
    case 'restore': return [`从 ${step.from} 整库导入（${step.instances.join('、')}）`, `Import the whole graph from ${step.from} (${step.instances.join(', ')})`];
    case 'prune': return [`解除锁之后永久删除旧的恢复文件夹 ${step.path}${size[0]}（只有数据库程序和记录，没有图谱数据；超过 ${step.keepDays} 天，之后又有至少 ${step.keepRuns} 次恢复；删不掉不影响恢复）`,
      `After the lock is released, permanently delete the old recovery folder ${step.path}${size[1]} (only database programs and records, no graph data; over ${step.keepDays} days old, with at least ${step.keepRuns} newer recoveries; if it cannot be deleted, the recovery still counts)`];
    case 'release-lock': return ['解除数据库维护锁', 'Release the database maintenance lock'];
    default: return [step.do, step.do];
  }
}

// What a moved directory is, in words.
function what(path) {
  if (/[\\/]data[\\/]databases[\\/]neo4j$/.test(path)) return ['一个图谱的数据库', 'a graph database'];
  if (/[\\/]transactions[\\/]neo4j$/.test(path)) return ['它的事务日志', 'its transaction logs'];
  if (/[\\/]jvs-a-[^\\/]+$/.test(path)) return ['一份数据库程序', 'a copy of the database programs'];
  if (/[\\/]neo4j-community-[^\\/]+$/.test(path)) return ['数据库程序', 'the database programs'];
  return ['目录', 'the directory'];
}

export function formatRecoveryPlan(plan) {
  if (plan.kind === 'nothing') return '没有要恢复的东西。 / There is nothing to recover.';
  if (plan.kind === 'refused') return `没有恢复：${refusalWords(plan)[0]} / Not recovered: ${refusalWords(plan)[1]}`;
  const [zh, en] = kindWords(plan);
  const lines = [zh, en, ...facts(plan), ...plan.steps.map((step, index) => `${index + 1}. ${stepWords(step, plan)[0]} / ${stepWords(step, plan)[1]}`)];
  const { verb, verbEn, from, to, fromEn, toEn } = switchWords(plan);
  if (plan.alternative?.kind === 'back_out_switch') {
    lines.push(`也可以取消${verb}、留在 ${from}：${RECOVER} --back-out。 / You can also cancel the ${verbEn} and stay on ${fromEn}: \`${RECOVER} --back-out\`.`);
  } else if (plan.alternative?.kind === 'finish_switch') {
    lines.push(`也可以完成${verb}、改用 ${to}：${RECOVER}（不带 --back-out）。 / You can also finish the ${verbEn} to ${toEn}: \`${RECOVER}\` without --back-out.`);
  } else if (plan.alternativeRefused) {
    const [why, whyEn] = backOutWords(plan.alternativeRefused, from, fromEn);
    lines.push(`不能取消${verb}、回到 ${from}：${why} / Cancelling the ${verbEn} back to ${fromEn} is not possible: ${whyEn}`);
  }
  if (plan.backOutFailed) {
    const [why, whyEn] = backOutWords(plan.backOutFailed, from, fromEn);
    lines.push(`上次取消${verb}、回到 ${from} 没有走通：${why} / Cancelling the ${verbEn} back to ${fromEn} stopped last time: ${whyEn}`);
  }
  if (plan.kind === 'finish_switch' && plan.keepable) {
    lines.push(`如果 ${to} 也起不来，可以完成${verb}并解除这把锁、不做启动检查：${KEEP_NEWER}（它先说明会怎样，要你确认）。 / If ${toEn} does not start either, finish the ${verbEn} and release this lock without a start check: \`${KEEP_NEWER}\` (it says what it does first and asks you to confirm).`);
  }
  return lines.join('\n');
}

// Why going back to the side a switch came from is not offered, or did not
// work (neo4j-recovery.js backOutBlocked, backOutFailed).
function backOutWords(reason, from, fromEn) {
  return ({
    no_fingerprint: [`切换记录里没有 ${from} 程序的指纹，没法确认它完好。`, `the switch journal has no fingerprint of ${fromEn}'s programs, so they cannot be checked.`],
    assets_changed: [`${from} 的数据库程序变过。`, `${fromEn}'s database programs changed.`],
    format_changed: ['存储格式已经和切换前不一样。', 'the store format is no longer the one from before the switch.'],
    format_unreadable: ['读不出存储格式：读它用的是现在生效的这一份程序和 Java，它们可能坏了，所以没法确认回去是安全的。',
      'the store format cannot be read: it is read with the programs and Java now in effect, which may be broken, so going back cannot be checked as safe.'],
    unmanaged_path: [`${from} 的程序不在 FULI 管理的位置。`, `${fromEn}'s programs are outside the places FULI manages.`]
  })[reason] ?? [String(reason), String(reason)];
}

// What the person should know before confirming, beyond the steps.
function facts(plan) {
  const lines = [];
  if (plan.backupPath && ['finish_switch', 'back_out_switch', 'keep_newer'].includes(plan.kind)) {
    lines.push(`升级前的图备份在 ${plan.backupPath}。 / The graph backup from before the upgrade is at ${plan.backupPath}.`);
  }
  if (plan.kind === 'abandon_load') lines.push(...abandonFacts(plan));
  if (plan.kind === 'restore_load') {
    const copy = plan.restorePoint;
    if (plan.restored) {
      lines.push('图已经从导入前的副本导回，这次不再导一遍。 / The graph is already back from the copy taken before the import; it is not imported again.');
    }
    if (copy) {
      const at = localClockTime(copy.createdAt, { date: true }) ?? copy.createdAt;
      lines.push(`用这次导入开始前（${at}）自动留下的备份恢复 ${copy.instances.join('、')}：${copy.path}。 / ${copy.instances.join(', ')} ${copy.instances.length === 1 ? 'goes' : 'go'} back to the copy this import took before it started (${at}): ${copy.path}.`);
    }
    if (plan.emptied?.length) {
      lines.push(`${plan.emptied.join('、')} 在导入前是空的，恢复后也是空的。 / ${plan.emptied.join(', ')} ${plan.emptied.length === 1 ? 'was' : 'were'} empty before the import and will be empty again.`);
    }
    if (plan.setAsideFailed) {
      const { graph, detail } = plan.setAsideFailed;
      lines.push(`导入自己退回时没能把 ${graph}（导入前是空的）挪开：${detail}。这次会再挪一遍。 / The import's own rollback could not move ${graph} (empty before the import) aside: ${detail}. This run moves it again.`);
    }
    if (plan.restoreFailed) {
      const [why, whyEn] = restoreFailureWords(plan.restoreFailed);
      lines.push(`上次导回没有成功：${why}这次会再导一遍；还是不行的话，可以放弃这次导入：${ABANDON}（副本留着，之后还能导回）。 / Bringing it back failed last time: ${whyEn} This run tries again; if it fails again, you can abandon the import: \`${ABANDON}\` (the copy stays, to import later).`);
    }
  }
  return lines;
}

// Giving up an import: why its copy cannot be used (or would not go back),
// what each graph now holds — half written by the import or by bringing it
// back (moves aside, ends up empty), this import's new data, or the data from
// before it; for a graph the lock names no state for, what its file times
// say — where the moved stores go and how to move them back, and which copies
// an import can bring back.
function abandonFacts(plan) {
  const zh = ids => (ids ?? []).join('、'), en = ids => (ids ?? []).join(' and ');
  const recovered = join(plan.dataDir, 'native-runtime', 'recovered');
  const folder = [plan.folder ?? `${recovered}/<时间>`, plan.folder ?? `${recovered}/<time>`];
  const failure = plan.copyProblem === 'restore_failed' ? restoreFailureWords(plan.restoreFailed ?? {}) : ['', ''];
  const lines = [({
    unrecorded: ['这次导入没有记下它在导入前留的是哪一份副本，或记下的认不出。', 'This import did not record which copy it took before it started, or recorded one FULI cannot recognise.'],
    missing: [`这次导入在导入前留的副本找不到了：${plan.backupPath}。`, `The copy this import took before it started is gone: ${plan.backupPath}.`],
    damaged: [`这次导入在导入前留的副本已损坏（读不出或校验和不对）：${plan.backupPath}。`, `The copy this import took before it started is damaged (unreadable, or its checksums do not match): ${plan.backupPath}.`],
    restore_failed: [`这次导入在导入前留的副本是好的（校验和对得上）：${plan.backupPath}，但把它导回没有成功：${failure[0]}放弃导入后这份副本还在；原因解决后可以用下面列出的 fuli graph import 命令把它导回。`,
      `The copy this import took before it started is good (its checksums match): ${plan.backupPath}, but bringing it back failed: ${failure[1]} It stays after you abandon the import; once the cause is fixed, bring it back with its \`fuli graph import\` command listed below.`]
  })[plan.copyProblem] ?? ['导入前的副本用不了。', 'The copy taken before the import cannot be used.']];
  if (plan.allInstances) lines.push(['这把锁是旧版本 FULI 留下的，没有记下导入的是哪些图谱，所以每个图谱都按文件的修改时间判断。', 'An older FULI took this lock and did not record which graphs it was importing, so every graph is judged by when its files last changed.']);
  if (plan.halfWritten?.length) {
    lines.push([`${zh(plan.halfWritten)}：这次导入写它的时候停下了（被打断或失败），可能只写了一半。继续的话会变成空的图谱，它的库和事务日志移到 ${folder[0]}，不删除。`,
      `${en(plan.halfWritten)}: this import stopped (killed or failed) while writing it, so it may be half written. If you go on, it will be empty; its database and transaction logs move to ${folder[1]}, not deleted.`]);
  }
  if (plan.restoreUnfinished?.length) {
    const back = plan.copyProblem === 'restore_failed'
      ? ['原因解决后，可以用下面这次导入前的副本把它导回。', ' Once the cause is fixed, the copy from before this import listed below brings it back.'] : ['', ''];
    lines.push([`${zh(plan.restoreUnfinished)}：把它从这次导入前的副本导回时停下了（被打断或没有成功），可能只写了一半。继续的话会变成空的图谱，它的库和事务日志移到 ${folder[0]}，不删除。${back[0]}`,
      `${en(plan.restoreUnfinished)}: bringing it back from the copy taken before this import stopped (killed or failed), so it may be half written. If you go on, it will be empty; its database and transaction logs move to ${folder[1]}, not deleted.${back[1]}`]);
  }
  for (const id of plan.imported ?? []) {
    const back = plan.copyProblem === 'restore_failed' && plan.inCopy?.includes(id)
      ? [`想让它也回到导入前：原因解决后，用下面这次导入前的副本（${plan.backupPath}）导回。`, `To take it back to before the import as well: once the cause is fixed, import this import's own copy (${plan.backupPath}) listed below.`]
      : !plan.inCopy?.includes(id)
        ? ['它在导入前是空的，导入前的副本里没有它。', 'It was empty before the import, so no copy from before it holds it.']
        : ['这次导入前的副本用不了，没有副本能把它换回这次导入前；下面列出的更早的副本只能换回更早的时候。', 'This import\'s own copy cannot be used, so no copy takes it back to just before this import; the earlier copies listed below take it back further.'];
    lines.push([`${id}：已经完整导入了这次的新数据，留在原位。放弃导入不会让它回到导入前。${back[0]}`,
      `${id}: it already holds all of this import's new data and stays as it is. Abandoning the import does not take it back to before. ${back[1]}`]);
  }
  if (plan.beforeImport?.length) {
    lines.push([`${zh(plan.beforeImport)}：还是导入前的数据，留在原位。`, `${en(plan.beforeImport)}: still the data from before the import; it stays as it is.`]);
  }
  if (plan.written?.length) {
    lines.push([`${zh(plan.written)}：看文件的修改时间，导入开始后它的库被写过，可能只写了一半。继续的话会变成空的图谱，写过的库移到 ${folder[0]}，不删除。`,
      `${en(plan.written)}: by its file times, its database was written after the import began and may be half written. If you go on, it will be empty; the written database moves to ${folder[1]}, not deleted.`]);
  }
  if (plan.unsure?.length) {
    lines.push([`${zh(plan.unsure)}：判断不了它有没有被这次导入写过（读不到文件的修改时间），为安全起见一起挪开，不删除。继续的话会变成空的图谱，库移到 ${folder[0]}；怎么搬回来见下面。`,
      `${en(plan.unsure)}: whether this import wrote it cannot be told (its file times cannot be read), so to be safe it moves aside too, not deleted. If you go on, it will be empty; the database moves to ${folder[1]}; how to move it back is below.`]);
  }
  if (plan.untouched?.length) {
    lines.push([`${zh(plan.untouched)}：看文件的修改时间，导入开始后没有被写过，原地不动。`, `${en(plan.untouched)}: by its file times, not written since the import began; it stays as it is.`]);
  }
  if (plan.moveBack?.length) {
    lines.push(['想把挪走的库搬回原位：先退出 FULI（fuli stop），如果原位置已经有 FULI 新建的空库，先把它改名挪开，再运行：',
      'To move a database back where it was: first quit FULI (`fuli stop`); if FULI already made a new empty database there, rename it out of the way; then run:']);
    for (const { from, to } of plan.moveBack) lines.push(`  mv "${from}" "${to}"`);
  }
  if (plan.copies?.length) {
    lines.push(['之后也可以用下面的命令从一份导入前的副本整库导回（会覆盖当时的图谱）：', 'Afterwards, an import can also bring back a whole copy taken before an import (it replaces the graph then):']);
    for (const copy of plan.copies) {
      const at = localClockTime(copy.createdAt, { date: true }) ?? copy.createdAt ?? '?';
      const command = `fuli graph import --input "${copy.path}" --data-dir "${plan.dataDir}" --yes`;
      lines.push(`  ${at} · ${byteSize(copy.bytes)} · ${copy.instances.join(', ')}: ${command}`);
    }
  } else {
    lines.push([`${join(plan.dataDir, 'backups', 'graph')} 里没有可以导回的导入前副本；有自己的导出时，用 fuli graph import --input <导出目录> 导回。`,
      `${join(plan.dataDir, 'backups', 'graph')} holds no copy from before an import to bring back; with an export of your own, bring it back with \`fuli graph import --input <export folder>\`.`]);
  }
  return lines.map(line => typeof line === 'string' ? line : `${line[0]} / ${line[1]}`);
}

// Why bringing an import's copy back failed (load-recovery.js restoreFailure):
// the error, the free space beside what a restore needs, and the processes
// still using a graph's directory.
function restoreFailureWords(failure) {
  const space = Number.isFinite(failure.freeBytes) && failure.leastBytes > 0
    ? [`磁盘剩余 ${byteSize(failure.freeBytes)}，导回至少需要 ${byteSize(failure.leastBytes)}。`, ` ${byteSize(failure.freeBytes)} is free on the disk; bringing it back needs at least ${byteSize(failure.leastBytes)}.`]
    : ['', ''];
  // An orphaned Neo4j holding the store: the start that offers to end it is held back by the lock, so the words say how.
  const holders = failure.holders?.length
    ? [`还有进程在用图谱的目录：${failure.holders.map(({ pid, name }) => `${pid}（${name ?? '?'}）`).join('、')}，可能是 FULI 之前没关掉的数据库；先结束它（${killCommand(failure.holders.map(({ pid }) => pid))}）。`,
      ` Processes still use a graph's directory: ${failure.holders.map(({ pid, name }) => `${pid} (${name ?? '?'})`).join(', ')}, likely a database FULI did not stop; end it first (\`${killCommand(failure.holders.map(({ pid }) => pid))}\`).`]
    : ['', ''];
  return [`${failure.detail ?? '?'}。${space[0]}${holders[0]}`, `${failure.detail ?? '?'}.${space[1]}${holders[1]}`];
}

// Once it is done: where its record is, why Neo4j did not start after an
// import was taken back, what could not be deleted, and the recovered folders
// that hold graph data (never deleted by the clean-up: a person decides).
export function recoveredLine(result) {
  const record = result.record ? ` 做了什么记在 ${result.record}。 / What it did is recorded in ${result.record}.` : '';
  const kept = result.notDeleted?.length
    ? ` 有 ${result.notDeleted.length} 个旧的恢复文件夹没删掉，留在原处：${result.notDeleted.map(({ path }) => path).join('、')}。 / ${result.notDeleted.length} old recovery folder(s) could not be deleted and stay: ${result.notDeleted.map(({ path }) => path).join(', ')}.`
    : '';
  const lines = [];
  if (result.startFailure) {
    const why = startFailureWords(result.startFailure);
    lines.push(`图已经回到导入前，数据库维护锁已解除；但数据库这次没能启动：${why[0]} 运行 fuli start，它会说明原因和下一步。${record}`,
      `The graph is back to before the import and the maintenance lock is released, but the database did not start this time: ${why[1]} Run \`fuli start\`, which says why and what to do next.${record}`);
  } else {
    const check = result.kind === 'abandon_load' ? ['运行 fuli start 检查能不能启动。', ' Run `fuli start` to check it starts.'] : ['', ''];
    lines.push(`已恢复，可以启动 FULI 了。${check[0]} / Recovered; FULI can start now.${check[1]}${record}${kept}`);
  }
  lines.push(...graphDataLines(result.keptGraphData));
  return lines.join('\n');
}

// Why a start check failed (neo4j-recovery.js startFailureOf): its message, and where the databases' logs are.
function startFailureWords(failure) {
  const port = failure.failure?.code === 'port_taken'
    ? [`端口 ${failure.failure.port} 被${failure.failure.pid ? `进程 ${failure.failure.pid} ` : '别的程序'}占着。`, `Port ${failure.failure.port} is in use${failure.failure.pid ? ` by process ${failure.failure.pid}` : ''}.`]
    : ['', ''];
  const logs = failure.logs?.length ? [`日志在 ${failure.logs.join('、')}。`, ` Logs are in ${failure.logs.join(', ')}.`] : ['', ''];
  return [`${port[0]}${failure.message}。${logs[0]}`, `${port[1] ? `${port[1]} ` : ''}${failure.message}.${logs[1]}`];
}

// The recovered folders that hold graph data (recovered-dir.js graphDataFolders):
// where, how big, which graphs, and how to move each store back. Also said by `fuli diagnostics`.
export function graphDataLines(folders) {
  if (!folders?.length) return [];
  const lines = ['recovered 文件夹里有挪开的图谱数据，自动清理不会删它们；确认不需要后由你自己删除。 / The recovered folder holds graph data that was moved aside; the clean-up never deletes it, so delete it yourself once you are sure it is not needed.'];
  for (const folder of folders) {
    lines.push(`  ${folder.path} · ${byteSize(folder.bytes)} · ${folder.instances.join(', ')}`);
  }
  lines.push('要搬回原位：先退出 FULI（fuli stop），原位置已有新建的空库时先把它改名挪开，再运行： / To move one back: quit FULI first (`fuli stop`); if a new empty database is already there, rename it out of the way; then run:');
  for (const folder of folders) for (const { from, to } of folder.stores) lines.push(`  mv "${from}" "${to}"`);
  return lines;
}

function refusalWords(plan) {
  const recovered = plan.path ? join(dirname(dirname(plan.path)), 'recovered') : 'native-runtime/recovered';
  const record = plan.record ? `做了的步骤记在 ${plan.record}。` : '';
  const recordEn = plan.record ? ` The steps done are recorded in ${plan.record}.` : '';
  const backup = plan.backupPath ? `升级前的图备份在 ${plan.backupPath}。` : '';
  const backupEn = plan.backupPath ? ` The graph backup from before the upgrade is at ${plan.backupPath}.` : '';
  // What FULI no longer decides by itself: the manual way out, with the paths filled in.
  const root = plan.runtimeDir ?? 'native-runtime';
  const aside = join(root, 'recovered', 'by-hand');
  const moves = moveIntoCommand(aside, join(root, '.neo4j-lifecycle.lock'));
  const journalMove = moveIntoCommand(aside, join(root, 'neo4j-transaction.json'));
  const look = [`数据库维护锁和切换记录都留着，FULI 不再往下做。要自己解开：先退出 FULI（fuli stop），在终端里运行 ${moves}，有 ${join(root, 'neo4j-transaction.json')} 时再运行 ${journalMove}（都是移开，不要删除），再启动 FULI；图谱打不开时用备份整库导回：fuli graph import --input <备份目录> --yes${plan.backupPath ? `（升级前的备份是 ${plan.backupPath}）` : ''}。也可以把 fuli diagnostics 的输出交给帮你看的人。`,
    `The maintenance lock and the switch journal stay and FULI goes no further. To get out by hand: quit FULI (\`fuli stop\`), run \`${moves}\` in a terminal, and when ${join(root, 'neo4j-transaction.json')} is there, \`${journalMove}\` too (moved, not deleted), then start FULI; if the graph does not open, import a backup whole: \`fuli graph import --input <backup folder> --yes\`${plan.backupPath ? ` (the backup from before the upgrade is ${plan.backupPath})` : ''}. The output of \`fuli diagnostics\` also helps whoever looks.`];
  const { verb, verbEn, from, to, fromEn, toEn } = switchWords(plan);
  // The exit when neither finishing nor going back gets Neo4j to start: only
  // when going back is not possible, or was tried ([keepable]).
  const failedBack = plan.backOutFailed ? backOutWords(plan.backOutFailed, from, fromEn) : null;
  const keep = plan.keepable ? [`${failedBack ? `取消${verb}没有走通：${failedBack[0]}` : ''}如果 ${to} 就是起不来、也回不到 ${from}，可以完成${verb}并解除这把锁、不做启动检查：${KEEP_NEWER}（它先说明会怎样，要你确认；之后不能再回到 ${from}）。解锁后起不来就是一次普通的启动失败${plan.backupPath ? `；升级前的图备份可以这样导回：fuli graph import --input "${plan.backupPath}" --yes` : ''}。`,
    `${failedBack ? ` Cancelling the ${verbEn} did not work: ${failedBack[1]}` : ''} If ${toEn} will not start and going back to ${fromEn} does not work either, finish the ${verbEn} and release this lock without a start check: \`${KEEP_NEWER}\` (it says what it does first and asks you to confirm; ${fromEn} is out of reach afterwards). A start that fails then is an ordinary failed start${plan.backupPath ? `; the graph backup from before the upgrade imports with \`fuli graph import --input "${plan.backupPath}" --yes\`` : ''}.`] : ['', ''];
  const why = plan.startFailure ? startFailureWords(plan.startFailure) : ['', ''];
  // The other way out of the same switch, only when it is there.
  const other = plan.alternative === 'back_out_switch'
    ? [`可以取消${verb}、留在 ${from}：${RECOVER} --back-out。`, `You can cancel the ${verbEn} and stay on ${fromEn}: \`${RECOVER} --back-out\`.`]
    : plan.alternative === 'finish_switch' || ['back_out_switch', 'continue_back_out'].includes(plan.planKind)
      ? [`可以完成${verb}、改用 ${to}：${RECOVER}。`, `You can finish the ${verbEn} to ${toEn}: \`${RECOVER}\`.`]
      : ['', ''];
  const switchKinds = ['finish_switch', 'back_out_switch', 'continue_back_out'];
  return ({
    holder_running: [`进程 ${plan.pid} 还在用数据库维护锁。等它结束后再运行 ${RECOVER}。`, `Process ${plan.pid} still holds the maintenance lock. Run \`${RECOVER}\` again once it ends.`],
    fuli_running: [`另一个 FULI 命令（进程 ${plan.pid}）正在用这份数据。等它结束后再运行 ${RECOVER}。`, `Another FULI command (process ${plan.pid}) is using this data. Run \`${RECOVER}\` again once it ends.`],
    cannot_inspect: [`看不到正在运行的程序，没法确认没人在用。稍后再运行 ${RECOVER}。`, `The running programs could not be listed, so nobody using it could be ruled out. Run \`${RECOVER}\` again later.`],
    no_holder: ['这把锁没有记录是谁加的。用 fuli graph runtime unlock 解除它，它会先做同样的检查。', 'This lock records no holder. Release it with `fuli graph runtime unlock`, which makes the same checks first.'],
    too_recent: [`这把锁没有记录是谁加的，加上还不到 90 分钟，可能还有人在用。${localClockTime(plan.releasableAt, { date: true }) ?? plan.releasableAt} 之后再运行 ${RECOVER}。`,
      `This lock records no holder and is less than 90 minutes old, so it may still be in use. Run \`${RECOVER}\` again after ${plan.releasableAt}.`],
    cannot_stop_services: [`图服务（进程 ${plan.pid}）还在运行，又没有锁的令牌能停它。先结束它：${killCommand([plan.pid])}，再运行 ${RECOVER}。`,
      `A graph service (process ${plan.pid}) still runs and there is no lock token to stop it with. End it first: \`${killCommand([plan.pid])}\`, then run \`${RECOVER}\` again.`],
    manifest_changed: [`数据库描述文件 manifest.json 既不是操作前也不是操作后的样子，可能有人改过或重装过。${look[0]}`,
      `The database descriptor manifest.json is neither the one from before nor after the operation; it may have been changed or reinstalled. ${look[1]}`],
    unknown_journal: [`切换记录 neo4j-transaction.json 是空的、坏了或看不懂。${look[0]}`, `The switch journal neo4j-transaction.json is empty, damaged or unreadable. ${look[1]}`],
    unmanaged_path: [`记录里的数据库程序目录不在 FULI 管理的位置，FULI 不动它。${look[0]}`, `The records name database programs outside the places FULI manages, so FULI leaves them alone. ${look[1]}`],
    assets_changed: [`数据库程序在操作中途被改过。${look[0]}`, `The database programs changed during the operation. ${look[1]}`],
    unknown_assets: [`neo4j-assets 里有一个认不出的目录（${plan.directory}）：名字像 FULI 的，但里面没有 FULI 的记录，可能是一次更新在写记录前就停了，也可能是别的东西。FULI 没有动它。看过确认不需要后，把它移开（不要删除）：${moveIntoCommand(recovered, plan.path)}，再运行 ${RECOVER}。`,
      `neo4j-assets holds a directory FULI cannot recognise (${plan.directory}): its name looks like FULI's but it carries no FULI record; an update may have stopped before writing one, or it is something else. FULI left it alone. Once you are sure it is not needed, move it away (do not delete it): \`${moveIntoCommand(recovered, plan.path)}\`, then run \`${RECOVER}\` again.`],
    no_fingerprint: [`切换记录里没有 ${from} 程序的指纹，没法确认它完好，所以不能取消${verb}；只能完成${verb}：${RECOVER}。`,
      `The switch journal has no fingerprint of ${fromEn}'s programs, so they cannot be checked and the ${verbEn} cannot be cancelled; it can only be finished: \`${RECOVER}\`.`],
    back_out_available: [`现在还能取消${verb}、留在 ${from}，所以不跳过启动检查直接完成${verb}（那样之后就回不到 ${from}）。先试：${RECOVER} --back-out；${from} 也起不来时，才可以用 ${KEEP_NEWER}。`,
      `Cancelling the ${verbEn} and staying on ${fromEn} is still possible, so it is not finished without a start check (${fromEn} would be out of reach afterwards). Try \`${RECOVER} --back-out\` first; only if ${fromEn} does not start either is \`${KEEP_NEWER}\` open.`],
    format_changed: switchKinds.includes(plan.planKind)
      ? [`存储格式和切换前记下的不一样，所以没有往下做，描述文件保持原样，锁和切换记录留着。${other[0]}${keep[0]}${record}`,
        `The store format is not the one recorded before the switch, so it went no further; the descriptor was left as it was, and the lock and journal stay. ${other[1]}${keep[1]}${recordEn}`]
      : [`存储格式和切换前记下的不一样，继续不安全。${backup}${look[0]}`, `The store format is not the one recorded before the switch, so going on is unsafe.${backupEn} ${look[1]}`],
    format_unreadable: [`读不出存储格式（数据库可能还在运行，或需要先自行恢复）。锁和记录都留着，稍后再运行 ${RECOVER}。`,
      `The store format could not be read (the database may still run, or need its own recovery). The lock and journal stay; run \`${RECOVER}\` again later.`],
    start_failed: [`${['back_out_switch', 'continue_back_out'].includes(plan.planKind) ? `${from} 没能启动或没有应答，描述文件已经写回 ${to}` : `${to} 没能启动或没有应答，描述文件保持原样`}，锁和切换记录都留着。${why[0]}${other[0]}原因解决后可以再运行一次 ${RECOVER}。${keep[0]}${record}`,
      `${['back_out_switch', 'continue_back_out'].includes(plan.planKind) ? `${fromEn} did not start or did not answer; ${toEn}'s descriptor was written back` : `${toEn} did not start or did not answer; the descriptor was left as it was`}, and the lock and journal stay. ${why[1]} ${other[1]} Once the cause is fixed, run \`${RECOVER}\` again.${keep[1]}${recordEn}`],
    restore_failed: [`没能把导入前的副本导回：${restoreFailureWords(plan)[0]}锁留着，启动会被挡住。副本本身是好的${plan.backupPath ? `：${plan.backupPath}` : ''}。原因解决后（例如腾出磁盘空间、结束占着库的进程）再运行一次 ${RECOVER} 会接着做；一直导不回去的话，也可以放弃这次导入：${ABANDON}，它先说明会怎样，副本留着，之后还能导回。${record}`,
      `Bringing back the copy taken before the import did not finish: ${restoreFailureWords(plan)[1]} The lock stays, so nothing starts on a half-written graph. The copy itself is good${plan.backupPath ? `: ${plan.backupPath}` : ''}. Once the cause is fixed (free disk space, or end the process holding the store, say), running \`${RECOVER}\` again continues it; if it keeps failing, you can abandon the import: \`${ABANDON}\` says what that means first, and the copy stays to import later.${recordEn}`],
    restore_point_unknown: [`这次导入没有记下它在导入前留的是哪一份副本，FULI 不猜。可以放弃这次导入：${ABANDON}，它先说明会怎样（被这次导入写过的图谱会变成空的，库移到一边、不删除）和之后怎么搬回、怎么从哪份副本导回，要你在终端里确认。`,
      `This import did not record which copy it took before it started, and FULI does not guess. You can abandon the import: \`${ABANDON}\` first says what that means (the graphs this import wrote become empty; their databases move aside, not deleted), how to move them back and which copy an import can bring back, and asks you to confirm in the terminal.`],
    restore_point_damaged: [`这次导入在导入前留下的副本（${plan.backupPath}）${plan.why === 'missing' ? '找不到了' : '已损坏'}，FULI 不改用别的副本。可以放弃这次导入：${ABANDON}，它先说明会怎样和之后怎么导回，要你在终端里确认。${record}`,
      `The copy this import took before it started (${plan.backupPath}) is ${plan.why === 'missing' ? 'gone' : 'damaged'}, and FULI does not use another one instead. You can abandon the import: \`${ABANDON}\` first says what that means and how to import a copy back afterwards, and asks you to confirm in the terminal.${recordEn}`],
    restore_point_usable: [`这次导入在导入前留下的副本还能用，不需要放弃导入：运行 ${RECOVER}，它把图撤回到导入前。`,
      `The copy this import took before it started can still be used, so there is no need to abandon the import: run \`${RECOVER}\`, which takes the graph back to before it.`],
    no_import: [`现在没有中途停下的导入可以放弃。运行 ${RECOVER} 看要做什么。`, `There is no interrupted import to abandon. Run \`${RECOVER}\` to see what is needed.`],
    abandon_needs_typing: [`放弃导入只在你自己敲命令的终端里、输入 abandon 确认后才做，不接受 --yes。`, 'Abandoning an import happens only in a terminal you type in, after you type abandon; --yes is not accepted.'],
    lock_changed: [`锁在恢复途中变了。再运行一次 ${RECOVER}。`, `The lock changed during the recovery. Run \`${RECOVER}\` again.`],
    recovery_running: [`另一个恢复（进程 ${plan.pid ?? '?'}）正在进行，这次什么都没做。等它结束后再运行 ${RECOVER} 看结果。`,
      `Another recovery (process ${plan.pid ?? '?'}) is in progress, so nothing was done. Once it ends, run \`${RECOVER}\` again to see where things stand.`],
    keep_newer_unavailable: [`现在没有已经生效、还没做完的更新或回退，没有要完成的。运行 ${RECOVER} 看要做什么。`,
      `There is no unfinished update or rollback that already took effect, so there is nothing to finish. Run \`${RECOVER}\` to see what is needed.`],
    step_failed: [`在“${plan.step}”这一步停下了，锁留着。再运行一次 ${RECOVER} 会接着做。${record}`, `It stopped at the step "${plan.step}" and the lock stays. Running \`${RECOVER}\` again continues it.${recordEn}`],
    plan_changed: [`情况在你确认之后变了，什么都没做；再运行 ${RECOVER} 看新的计划。`, `Things changed after you confirmed, so nothing was done; run \`${RECOVER}\` again to see the new plan.`],
    needs_person: ['恢复只在你自己敲命令的终端里做，或在桌面窗口里点「恢复并启动」；没有终端时只能看计划（--preview）。',
      'A recovery runs only in a terminal you type in, or from 「恢复并启动」 in the desktop window; without a terminal only the plan is shown (--preview).']
  })[plan.reason] ?? [String(plan.reason), String(plan.reason)];
}
