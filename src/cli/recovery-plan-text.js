import { basename, dirname, join } from 'node:path';

import { byteSize } from '../text/byte-size.js';
import { localClockTime } from '../text/clock-time.js';

// What `fuli graph runtime recover` says it will do, and why it will not, in
// both languages (src/native-runtime/neo4j-recovery.js plans it). The desktop
// client words the same plan its own way (strings.dart `recoveryPlanWords`).

const RECOVER = 'fuli graph runtime recover';
const ABANDON = `${RECOVER} --abandon-import`;
const KEEP_NEWER = `${RECOVER} --keep-newer`;

const KIND = {
  undo_switch: ['撤销一次没做完的数据库切换：新版本还没生效，回到切换前的状态。', 'Undo a database switch that did not finish: the newer version never took effect, so go back to before it.'],
  finish_switch: ['完成一次没做完的数据库切换：新版本已经生效；先确认它能启动、存储格式没变，再保留它。',
    'Finish a database switch that did not finish: the newer version already took effect; it is kept once it starts and the store format is unchanged.'],
  back_out_switch: ['撤回一次没做完的数据库切换：回到切换前的版本；先确认存储格式没变、旧版本能启动，不行就保持新版本。',
    'Back out a database switch that did not finish: return to the older version, once the store format is unchanged and the older version starts; otherwise the newer one stays.'],
  finish_uninstall: ['完成一次没做完的数据库卸载：剩下的数据库程序移到 recovered 文件夹，知识数据不动。', 'Finish a database uninstall that did not finish: the remaining database programs move to the recovered folder; knowledge data is not touched.'],
  clear_interrupted: ['清理一次中途停下的数据库操作：它停在改动数据之前，把装了一半的东西放到一边。', 'Clear up a database operation that stopped part way, before it changed any data: set aside what it half installed.'],
  release_dump: ['解除一次中途停下的导出留下的锁：导出只读数据库。', 'Release the lock an interrupted dump left: a dump only reads the database.'],
  continue_back_out: ['接着做一次中途停下的撤回：描述文件已经写回切换前的版本，但新版本之前已经打开过这个库；先确认旧版本还能启动，不行就写回新版本。',
    'Continue a back-out that stopped part way: the descriptor is already the older version\'s again, but the newer version had already opened the store; the older version must start on it, otherwise the newer descriptor is written back.'],
  finish_recovery: ['做完一次中途停下的恢复：它的步骤都做完了，只剩解除它加的锁。', 'Finish a recovery that stopped part way: its steps are done, only the lock it took is left.'],
  restore_load: ['把一次中途停下的导入撤回到导入前：导入可能只写了一半。这次想导入的内容不会保留，之后需要重新导入。',
    'Take an interrupted import back to before it: it may be half written. What it was importing is not kept; import it again afterwards.'],
  abandon_load: ['放弃一次中途停下的导入：导入前留下的副本用不了，没法撤回到导入前。只把这次导入写过的库挪开，没写过的原地不动。',
    'Abandon an interrupted import: the copy taken before it cannot be used, so the graph cannot go back to before the import. Only the databases this import wrote move aside; the others stay as they are.'],
  keep_newer: ['保留新版本并解除这把锁：不再做启动检查，切换记录移到 recovered 文件夹，解除数据库维护锁。之后启动失败按正常的启动失败处理。',
    'Keep the newer version and release the lock: no start check; the switch journal moves to the recovered folder and the maintenance lock is released. A start that fails afterwards is an ordinary failed start.']
};

function stepWords(step) {
  const size = step.bytes === undefined ? ['', ''] : [`，${byteSize(step.bytes)}`, `, ${byteSize(step.bytes)}`];
  switch (step.do) {
    case 'stop-services': return ['停止 FULI 记录的图数据库和 Provider 进程', 'Stop the graph database and Provider processes FULI recorded'];
    case 'check-start': return [`用 Neo4j${step.version ? ` ${step.version}` : ''} 启动一次，确认它能应答，再停下${step.revert ? '（不行就写回新版本的描述文件）' : ''}${step.afterRestore ? '（图已经导回，起不来也照样解除锁，并写明起不来的原因）' : ''}`,
      `Start Neo4j${step.version ? ` ${step.version}` : ''} once, check it answers, and stop it${step.revert ? ' (if it does not, the newer descriptor is written back)' : ''}${step.afterRestore ? ' (the graph is already back, so the lock is released even if it does not start, and why is said)' : ''}`];
    case 'mark-restored': return ['在锁里记下「已导回」：之后重跑不会再导一遍', 'Record in the lock that the graph is back, so running again does not import it again'];
    case 'mark-backing-out': return ['在切换记录里记下「正在撤回」', 'Record in the switch journal that it is being backed out'];
    case 'check-formats': return ['确认存储格式和切换前一样', 'Check the store format is still the one from before the switch'];
    case 'check-fingerprint': return ['确认旧版本的数据库程序没有变', 'Check the older database programs did not change'];
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
  }
  return lines;
}

// Giving up an import: why its copy cannot be used, which graphs the import
// wrote (they end up empty), which it may have written (moved too, said as
// such), which stay, where the moved stores go and how to move them back, and
// which copies an import can bring back.
function abandonFacts(plan) {
  const zh = ids => (ids ?? []).join('、'), en = ids => (ids ?? []).join(' and ');
  const recovered = join(plan.dataDir, 'native-runtime', 'recovered');
  const lines = [({
    unrecorded: ['这次导入没有记下它在导入前留的是哪一份副本，或记下的认不出。', 'This import did not record which copy it took before it started, or recorded one FULI cannot recognise.'],
    missing: [`这次导入在导入前留的副本找不到了：${plan.backupPath}。`, `The copy this import took before it started is gone: ${plan.backupPath}.`],
    damaged: [`这次导入在导入前留的副本已损坏（读不出或校验和不对）：${plan.backupPath}。`, `The copy this import took before it started is damaged (unreadable, or its checksums do not match): ${plan.backupPath}.`]
  })[plan.copyProblem] ?? ['导入前的副本用不了。', 'The copy taken before the import cannot be used.']];
  if (plan.allInstances) lines.push(['这把锁是旧版本 FULI 留下的，没有记下导入的是哪些图谱，所以每个图谱都按文件的修改时间判断。', 'An older FULI took this lock and did not record which graphs it was importing, so every graph is judged by when its files last changed.']);
  if (plan.written?.length) {
    lines.push([`${zh(plan.written)}：导入开始后它的库被写过，可能只写了一半。继续的话会变成空的图谱，写过的库移到 ${plan.folder ?? `${recovered}/<时间>`}，不删除。`,
      `${en(plan.written)}: its database was written after the import began and may be half written. If you go on, it will be empty; the written database moves to ${plan.folder ?? `${recovered}/<time>`}, not deleted.`]);
  }
  if (plan.unsure?.length) {
    lines.push([`${zh(plan.unsure)}：判断不了它有没有被这次导入写过（读不到文件的修改时间），所以一起挪开；它的库是完好的可能性很大。继续的话会变成空的图谱，库移到 ${plan.folder ?? `${recovered}/<时间>`}，不删除。`,
      `${en(plan.unsure)}: whether this import wrote it cannot be told (its file times cannot be read), so it moves aside too; its database is quite likely intact. If you go on, it will be empty; the database moves to ${plan.folder ?? `${recovered}/<time>`}, not deleted.`]);
  }
  if (plan.untouched?.length) {
    lines.push([`${zh(plan.untouched)}：导入开始后没有被写过，原地不动。`, `${en(plan.untouched)}: not written since the import began; it stays as it is.`]);
  }
  if (plan.moveBack?.length) {
    lines.push(['想把挪走的库搬回原位（例如判断不了、一起挪开的那个）：先退出 FULI（fuli stop），如果原位置已经有 FULI 新建的空库，先把它改名挪开，再运行：',
      'To move a database back where it was (say, one that moved because it could not be told): first quit FULI (`fuli stop`); if FULI already made a new empty database there, rename it out of the way; then run:']);
    for (const { from, to } of plan.moveBack) lines.push(`  mv "${from}" "${to}"`);
  }
  if (plan.copies?.length) {
    lines.push(['之后也可以用下面的命令从一份导入前的副本整库导回（会覆盖当时的图谱）：', 'Afterwards, an import can also bring back a whole copy taken before an earlier import (it replaces the graph then):']);
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
  const look = [`数据库维护锁和切换记录都留着，FULI 不再往下做。要自己解开：先退出 FULI，把 ${join(root, 'neo4j-transaction.json')}（如果有）和 ${join(root, '.neo4j-lifecycle.lock')} 移到 ${join(root, 'recovered')}/ 里（不要删除），再启动 FULI；图谱打不开时用备份整库导回：fuli graph import --input <备份目录> --yes${plan.backupPath ? `（升级前的备份是 ${plan.backupPath}）` : ''}。也可以把 fuli diagnostics 的输出交给帮你看的人。`,
    `The maintenance lock and the switch journal stay and FULI goes no further. To get out by hand: quit FULI, move ${join(root, 'neo4j-transaction.json')} (if there) and ${join(root, '.neo4j-lifecycle.lock')} into ${join(root, 'recovered')}/ (do not delete them), then start FULI; if the graph does not open, import a backup whole: \`fuli graph import --input <backup folder> --yes\`${plan.backupPath ? ` (the backup from before the upgrade is ${plan.backupPath})` : ''}. The output of \`fuli diagnostics\` also helps whoever looks.`];
  // The exit when neither finishing nor backing out gets the newer version to start.
  const keep = [`如果新版本就是起不来、也回不去，可以保留新版本并解除这把锁：${KEEP_NEWER}（它先说明会怎样，要你确认）。解锁后可以重新更新一次，或用升级前的备份导回${plan.backupPath ? `：fuli graph import --input "${plan.backupPath}" --yes` : ''}。`,
    `If the newer version will not start and going back does not work, keep the newer version and release this lock: \`${KEEP_NEWER}\` (it says what it does first and asks you to confirm). Afterwards, update again, or import the backup from before the upgrade${plan.backupPath ? `: \`fuli graph import --input "${plan.backupPath}" --yes\`` : ''}.`];
  const why = plan.startFailure ? startFailureWords(plan.startFailure) : ['', ''];
  // The other way out of the same switch, only when it is there.
  const other = plan.alternative === 'back_out_switch'
    ? [`可以撤回到 ${plan.fromVersion ?? '旧版本'}：${RECOVER} --back-out。`, `You can go back to ${plan.fromVersion ?? 'the older version'}: \`${RECOVER} --back-out\`.`]
    : plan.alternative === 'finish_switch' || ['back_out_switch', 'continue_back_out'].includes(plan.planKind)
      ? [`可以完成切换、保留 ${plan.toVersion ?? '新版本'}：${RECOVER}。`, `You can finish the switch and keep ${plan.toVersion ?? 'the newer version'}: \`${RECOVER}\`.`]
      : ['', ''];
  const switchKinds = ['finish_switch', 'back_out_switch', 'continue_back_out'];
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
    format_changed: switchKinds.includes(plan.planKind)
      ? [`存储格式和切换前记下的不一样，所以没有往下做，描述文件保持原样，锁和切换记录留着。${other[0]}${keep[0]}${record}`,
        `The store format is not the one recorded before the switch, so it went no further; the descriptor was left as it was, and the lock and journal stay. ${other[1]} ${keep[1]}${recordEn}`]
      : [`存储格式和切换前记下的不一样，继续不安全。${backup}${look[0]}`, `The store format is not the one recorded before the switch, so going on is unsafe.${backupEn} ${look[1]}`],
    format_unreadable: [`读不出存储格式（数据库可能还在运行，或需要先自行恢复）。锁和记录都留着，稍后再运行 ${RECOVER}。`,
      `The store format could not be read (the database may still run, or need its own recovery). The lock and journal stay; run \`${RECOVER}\` again later.`],
    start_failed: [`${['back_out_switch', 'continue_back_out'].includes(plan.planKind) ? `旧版本 ${plan.fromVersion ?? ''} 没能启动或没有应答，描述文件已经写回新版本` : `新版本 ${plan.toVersion ?? ''} 没能启动或没有应答，描述文件保持原样`}，锁和切换记录都留着。${why[0]}${other[0]}原因解决后可以再运行一次 ${RECOVER}。${keep[0]}${record}`,
      `${['back_out_switch', 'continue_back_out'].includes(plan.planKind) ? `The older version ${plan.fromVersion ?? ''} did not start or did not answer; the newer descriptor was written back` : `The newer version ${plan.toVersion ?? ''} did not start or did not answer; the descriptor was left as it was`}, and the lock and journal stay. ${why[1]} ${other[1]} Once the cause is fixed, run \`${RECOVER}\` again. ${keep[1]}${recordEn}`],
    restore_failed: [`没能从导入前的备份恢复${plan.detail ? `（${plan.detail}）` : ''}，锁留着，启动会被挡住。原因解决后（例如腾出磁盘空间）再运行一次 ${RECOVER} 会接着做；还不行就需要人来看，可以把 fuli diagnostics 的输出交给帮你看的人。${record}`,
      `Restoring from the copy taken before the import did not finish${plan.detail ? ` (${plan.detail})` : ''}; the lock stays, so nothing starts on a half-written graph. Once the cause is fixed (free disk space, say), running \`${RECOVER}\` again continues it; if it fails again, a person needs to look (the output of \`fuli diagnostics\` helps).${recordEn}`],
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
    keep_newer_unavailable: [`现在没有新版本已经生效、还没做完的切换，不需要保留新版本。运行 ${RECOVER} 看要做什么。`,
      `There is no unfinished switch whose newer version took effect, so there is nothing to keep. Run \`${RECOVER}\` to see what is needed.`],
    step_failed: [`在“${plan.step}”这一步停下了，锁留着。再运行一次 ${RECOVER} 会接着做。${record}`, `It stopped at the step "${plan.step}" and the lock stays. Running \`${RECOVER}\` again continues it.${recordEn}`],
    plan_changed: [`情况在你确认之后变了，什么都没做；再运行 ${RECOVER} 看新的计划。`, `Things changed after you confirmed, so nothing was done; run \`${RECOVER}\` again to see the new plan.`],
    needs_person: ['恢复只在你自己敲命令的终端里做，或在桌面窗口里点「恢复并启动」；没有终端时只能看计划（--preview）。',
      'A recovery runs only in a terminal you type in, or from 「恢复并启动」 in the desktop window; without a terminal only the plan is shown (--preview).']
  })[plan.reason] ?? [String(plan.reason), String(plan.reason)];
}
