import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { FULI_VERSION } from '../package-metadata.js';
import { diskFree, diskSize } from '../native-runtime/recovered-dir.js';
import { byteSize } from '../text/byte-size.js';
import { GRAPH_STATE } from './graph-import-states.js';
import { abandonImportCommand, graphImportCommand, unfinishedImportWayBack } from './unfinished-import.js';
import { sha256File } from '../security/digest.js';
import { killCommand } from '../text/terminal-command.js';

const BACKUP_FORMAT = 'fuli-neo4j-backup';
const BACKUP_VERSION = 1;

export async function exportGraphData({
  outputDir,
  sourceMode,
  follower = null,
  instances,
  adapter,
  now = () => new Date()
}) {
  const destination = requiredPath(outputDir, 'Backup output directory');
  validateMode(sourceMode, 'sourceMode');
  const selectedInstances = validateInstances(instances);
  assertAdapter(adapter, ['stop', 'dump', 'start']);
  if (await pathExists(destination)) {
    throw new Error('Backup output already exists; choose a new directory.');
  }
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${randomUUID()}`;
  await mkdir(partial, { recursive: false, mode: 0o700 });
  let lifecycle = null;
  let published = false;
  try {
    lifecycle = await adapter.stop();
    const exported = [];
    for (const id of selectedInstances) {
      const file = `${id}.dump`;
      const path = join(partial, file);
      await adapter.dump(id, path);
      await chmod(path, 0o600);
      exported.push({ id, file, sha256: await sha256File(path) });
    }
    const manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: now().toISOString(),
      sourceMode,
      fuliVersion: FULI_VERSION,
      instances: exported,
      ...(follower ? { computer: follower.computer, followsHost: follower.followsHost } : {}),
      ...(typeof adapter.selection === 'function'
        ? selectionProperty(await adapter.selection())
        : {})
    };
    if (follower && manifest.selection?.personalSpaceId !== follower.personalSpaceId) {
      throw new Error('The personal space changed during the backup.');
    }
    const manifestPath = join(partial, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(partial, destination);
    published = true;
    return {
      status: 'exported',
      outputDir: destination,
      sourceMode,
      instances: selectedInstances
    };
  } finally {
    if (!published) await rm(partial, { recursive: true, force: true });
    if (lifecycle?.resume === true) await adapter.start(lifecycle);
  }
}

export async function importGraphData({
  inputDir,
  targetMode,
  rollbackDir,
  adapter,
  now = () => new Date(),
  freeSpace = diskFree,
  follower = null, validateManifest = null
}) {
  const source = requiredPath(inputDir, 'Backup input directory');
  const rollbackBase = requiredPath(rollbackDir, 'Rollback directory');
  validateMode(targetMode, 'targetMode');
  assertAdapter(adapter, ['stop', 'dump', 'load', 'start']);
  const manifest = await readGraphBackupManifest(source);
  validateManifest?.(manifest);
  await verifyBackupFiles(source, manifest);
  if (
    Array.isArray(adapter.instances) &&
    manifest.instances.some(({ id }) => !adapter.instances.includes(id))
  ) {
    throw new Error(
      'The target runtime is not configured for every graph instance in this backup.'
    );
  }
  // An earlier import into this runtime that never finished (a runtime with no
  // lifecycle lock keeps its marker, unfinished-import.js). A graph it may have
  // left half written is not copied (there is nothing whole to keep), so this
  // import must write it, or it stays half written: one this backup lacks
  // stops the import before anything changes.
  const earlier = typeof adapter.unfinishedImport === 'function' ? await adapter.unfinishedImport() : null;
  const halfWritten = new Set((earlier?.partial ?? []).filter(id => !Array.isArray(adapter.instances) || adapter.instances.includes(id)));
  const lacking = [...halfWritten].filter(id => !manifest.instances.some(entry => entry.id === id));
  if (lacking.length) throw leftHalfWritten(lacking, earlier, targetMode);

  const rollbackRoot = join(
    rollbackBase,
    `before-import-${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  );
  await mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
  let lifecycle = null;
  const rollbackEntries = [];
  let rollbackReady = false;
  // The one lease this import holds from before it writes its first graph
  // until every graph is whole again (adapter.holdImport: the lifecycle lock
  // on macOS native, a marker elsewhere; a runtime without one guards
  // nothing). It is kept when that never happens, so nothing starts on a
  // half-written graph: a recovery takes over from what its lock records, or
  // the marker's error says how to import the copy back.
  let lease = null;
  let kept = false;
  let failure = null;
  try {
    lifecycle = await adapter.stop();
    for (const entry of manifest.instances) {
      if (halfWritten.has(entry.id)) continue;
      if (typeof adapter.hasData === 'function' && !await adapter.hasData(entry.id)) continue;
      const path = join(rollbackRoot, `${entry.id}.dump`);
      await adapter.dump(entry.id, path);
      await chmod(path, 0o600);
      rollbackEntries.push({ id: entry.id, path });
    }
    if (rollbackEntries.length > 0) {
      const rollbackManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: now().toISOString(),
        sourceMode: targetMode,
        fuliVersion: FULI_VERSION,
        reason: 'automatic-pre-import-rollback',
        ...(follower ? { computer: follower.computer, followsHost: follower.followsHost,
          selection: { personalSpaceId: follower.personalSpaceId } } : {}),
        instances: await Promise.all(rollbackEntries.map(async ({ id, path }) => ({
          id,
          file: basename(path),
          sha256: await sha256File(path)
        })))
      };
      await writeFile(join(rollbackRoot, 'manifest.json'),
        `${JSON.stringify(rollbackManifest, null, 2)}\n`, { mode: 0o600 });
      rollbackReady = true;
    } else {
      await rm(rollbackRoot, { recursive: true, force: true });
    }
    // What a recovery of an import killed part way goes back to (neo4j-recovery.js):
    // this copy (null when every instance was empty before), which instances it
    // holds, and which this import overwrites.
    const restorePoint = { path: rollbackReady ? rollbackRoot : null,
      instances: rollbackEntries.map(({ id }) => id), loading: manifest.instances.map(({ id }) => id) };
    // Where this import stands with each graph (graph-import-states.js), in the
    // lock before that graph is written and again once it is written, failed
    // or back, so a recovery or abandoning the import never guesses. A state
    // that could not be recorded (a full disk) stops the import where it is:
    // nothing more is written, and the lock stays.
    // A graph an earlier unfinished import may have left half written counts
    // as written already (unfinished-import.js): it is whole again only once
    // this import has written it all.
    const graphStates = Object.fromEntries(manifest.instances.map(({ id }) =>
      [id, halfWritten.has(id) ? GRAPH_STATE.importFailed : GRAPH_STATE.untouched]));
    lease = typeof adapter.holdImport === 'function'
      ? await adapter.holdImport({ restorePoint, graphStates: { ...graphStates }, inputDir: source })
      : UNLOCKED;
    let unrecorded = null;
    const mark = async (changes) => {
      if (unrecorded) throw unrecorded;
      Object.assign(graphStates, changes);
      try { await lease.record({ graphStates: { ...graphStates } }); }
      catch (error) { unrecorded = error; throw error; }
    };
    try {
      for (const entry of manifest.instances) {
        // A graph counts as being written from when the database is: an
        // adapter that says when (announcesWrites) records it right before
        // neo4j-admin writes, after the dump is staged; any other, before the load.
        const writing = () => mark({ [entry.id]: GRAPH_STATE.writing });
        if (adapter.announcesWrites !== true) await writing();
        await adapter.load(entry.id, join(source, entry.file), ...(adapter.announcesWrites === true ? [{ beforeWrite: writing }] : []));
        await mark({ [entry.id]: GRAPH_STATE.imported });
      }
      if (typeof adapter.reconcile === 'function') {
        await adapter.reconcile({
          selection: manifest.selection ?? {},
          sourceMode: manifest.sourceMode,
          targetMode,
          lifecycle
        });
      }
      // Every graph holds its new data and the identity is reconciled: a
      // recovery of an import killed from here on only checks the start and
      // releases the lock (load-recovery.js), and never takes it back. Not
      // recorded (a full disk), such a recovery restores the copy instead,
      // which loses nothing: the import's input is still there.
      await lease.record({ completed: true }).catch(() => {});
    } catch (error) {
      // Every graph this import wrote goes back: from the copy when it had
      // data before, or emptied again when it had none (adapter.setAside).
      // Graphs it never wrote stay as they are.
      let rollbackError = null;
      let restoreError = null;
      let setAsideError = null;
      // Graphs emptied again (where their half-written data went), and ones an
      // earlier import left half written that this one made whole.
      const asides = [];
      const wholeNow = [];
      if (!unrecorded) {
        try {
          const touched = Object.keys(graphStates).filter(id => graphStates[id] !== GRAPH_STATE.untouched);
          const failed = touched.filter(id => graphStates[id] === GRAPH_STATE.writing);
          if (failed.length) await mark(Object.fromEntries(failed.map(id => [id, GRAPH_STATE.importFailed])));
          for (const id of touched) {
            const copy = rollbackEntries.find(entry => entry.id === id);
            // Half written by the earlier import already: no copy holds it, and
            // it was not empty before. Written whole by this one, it keeps the new data.
            if (!copy && halfWritten.has(id)) {
              if (graphStates[id] === GRAPH_STATE.imported) { wholeNow.push(id); continue; }
              rollbackError ??= new Error(`the ${id} graph was left half written by an earlier unfinished import and this import did not write it whole`);
              continue;
            }
            if (!copy && typeof adapter.setAside !== 'function') {
              rollbackError ??= new Error(`The ${id} graph was empty before the import and this runtime cannot empty it again.`);
              continue;
            }
            await mark({ [id]: GRAPH_STATE.restoring });
            try {
              if (copy) await adapter.load(id, copy.path);
              else asides.push({ graph: id, ...await adapter.setAside(id) });
            } catch (caught) {
              rollbackError ??= caught;
              if (copy) restoreError ??= caught;
              else setAsideError ??= { graph: id, detail: String(caught?.message ?? caught), holders: caught?.holders ?? [] };
              await mark({ [id]: GRAPH_STATE.restoreFailed });
              continue;
            }
            await mark({ [id]: GRAPH_STATE.restored });
          }
          // Every graph is back: a recovery of an import killed from here on
          // only releases the lock (load-recovery.js).
          if (!rollbackError) await lease.record({ restored: true });
        } catch (caught) {
          unrecorded ??= caught;
        }
      }
      if (!unrecorded && !rollbackError) throw rolledBack(error, { asides, wholeNow, earlierCopy: earlier?.copy ?? null });
      kept = true;
      if (!unrecorded && restoreError) await lease.restoreFailed?.(rollbackRoot, restoreError).catch(() => {});
      // Why an emptied graph could not be emptied again, for the recovery's words.
      if (!unrecorded && setAsideError) await lease.record({ setAsideFailed: { graph: setAsideError.graph, detail: setAsideError.detail } }).catch(() => {});
      const cause = unrecorded ?? rollbackError;
      const full = [unrecorded, error, cause].some(noSpace)
        ? await spaceNeeded(rollbackReady ? rollbackRoot : null, rollbackBase, freeSpace) : null;
      // With a marker, the way back is the one it records: the copy from
      // before the first unfinished import, which this import's own copy may
      // not hold (it never copies a graph that may be half written).
      const marker = lease.marked === true ? await Promise.resolve(adapter.unfinishedImport?.()).catch(() => null) : null;
      throw incompleteImport(error, cause, {
        unrecorded: Boolean(unrecorded), locked: lease.locked, marked: lease.marked === true, copy: rollbackReady ? rollbackRoot : null,
        inputDir: source, targetMode, full, marker, setAsideError });
    }
    return {
      status: 'imported',
      inputDir: source,
      targetMode,
      instances: manifest.instances.map(({ id }) => id),
      rollbackDir: rollbackReady ? rollbackRoot : null,
      // The copy an earlier unfinished import took before it: still kept, and no longer named anywhere else.
      earlierCopy: earlier?.copy && earlier.copy !== rollbackRoot ? earlier.copy : null
    };
  } catch (error) {
    failure = error;
    if (!rollbackReady) await rm(rollbackRoot, { recursive: true, force: true });
    throw error;
  } finally {
    // Only with every graph whole: the lease goes, and what ran before starts
    // again. A lease that cannot be let go does not hide why the import failed.
    if (!kept) {
      try { await lease?.release(); }
      catch (releaseError) {
        if (!failure) throw releaseError;
        throw new AggregateError([failure, releaseError], `${failure.message} The import's lease could not be released either: ${releaseError.message}`, { cause: failure });
      }
      // A marker still there (an earlier unfinished import this one failed
      // before it took over) keeps this start off too: elsewhere a start is
      // refused while it is there, and here the container start is a plain compose up.
      const unfinished = typeof adapter.unfinishedImport === 'function'
        ? await Promise.resolve(adapter.unfinishedImport()).catch(() => true) : null;
      if (lifecycle?.resume === true && !unfinished) await adapter.start(lifecycle);
    }
  }
}

// A runtime whose imports guard nothing (an adapter without holdImport).
const UNLOCKED = Object.freeze({ locked: false, record: async () => {}, release: async () => {} });

const RECOVER = 'fuli graph runtime recover';

const noSpace = error => error?.code === 'ENOSPC' || /\bENOSPC\b|no space left/i.test(String(error?.message ?? ''));

// How much room a recovery needs on a full disk: bringing the copy back
// stages each dump and writes the database from it, at least twice the copy
// (load-recovery.js restoreFailure); the lock's own record needs a little.
async function spaceNeeded(copy, near, freeSpace) {
  let free = null;
  try { free = await freeSpace(near); } catch { /* unknown */ }
  return { copyBytes: copy ? diskSize(copy) : null, freeBytes: free };
}

// An import that failed and whose rollback brought every graph back: from
// its copy, or emptied again ([asides]: where the half-written database went,
// never deleted, and how to move it back); a graph an earlier unfinished
// import left half written and this one wrote whole keeps that data ([wholeNow]).
function rolledBack(error, { asides = [], wholeNow = [], earlierCopy = null } = {}) {
  const detail = error?.message ?? String(error);
  const [back, backEn] = wholeNow.length
    ? [`图谱 ${wholeNow.join('、')} 被上次没完成的导入只写了一半，这次已经把它完整导入，留着这次的新数据；其余图谱都已退回导入前的数据。`,
      ` The ${wholeNow.join(' and ')} graph, which an earlier unfinished import left half written, now holds this import's data whole and keeps it; every other graph is back to its data from before the import.`]
    : ['每个图谱都已退回导入前的数据。', ' Every graph is back to its data from before the import.'];
  const moved = asideWords(asides, '导入前是空的，已经重新清空', 'was empty before the import and is empty again');
  // The earlier unfinished import's record is gone now, and with it the only mention of the copy taken before it.
  const [kept, keptEn] = earlierCopy
    ? [`上次没完成的那次导入之前的副本还留着：${earlierCopy}，用不着时可以自己删掉。`,
      ` The copy taken before the earlier unfinished import is still kept at ${earlierCopy}; delete it yourself once it is not needed.`]
    : ['', ''];
  return new Error(`导入没有成功：${detail}。${back}${moved.map(([zh]) => zh).join('')}${kept}`
    + ` / Graph import failed: ${detail}.${backEn}${moved.map(([, en]) => en).join('')}${keptEn}`, { cause: error });
}

// Where each graph set aside went ([asides]: adapter.setAside), never
// deleted, and how to move it back, after [zhState] / [enState] saying why.
export function asideWords(asides, zhState, enState) {
// A container's move back sets a new empty database in the way aside itself ([replaced]).
  return asides.filter(aside => aside.where).map(({ graph, where, moveBack = [], volume, replaced }) => {
    const [empty, emptyEn] = replaced
      ? [`；原位置已经有新建的空库时，这条命令先把它挪进 ${replaced}（不删除）`, `; if a new empty database is already there, the command first moves it into ${replaced} (not deleted)`]
      : ['', ''];
    return [
      `图谱 ${graph} ${zhState}：它写了一半的库挪到了 ${where}${volume ? `（容器 ${graph}-neo4j 的 Docker 数据卷里）` : ''}，没有删除，用不着时可以自己删掉。${moveBack.length ? `要搬回去：先退出 FULI（fuli stop），${replaced ? '' : '原位置已经有新建的空库时先把它改名挪开，'}再运行 ${moveBack.join('；')}${empty}。` : ''}`,
      ` The ${graph} graph ${enState}: its half-written database moved to ${where}${volume ? ` (in the Docker volume of the ${graph}-neo4j container)` : ''}, not deleted; delete it yourself once it is not needed.${moveBack.length ? ` To move it back: quit FULI (\`fuli stop\`); ${replaced ? '' : 'if a new empty database is already there, rename it out of the way; '}then run \`${moveBack.join('`; `')}\`${emptyEn}.` : ''}`];
  });
}

// An import that failed and left a graph that may be half written: its
// rollback did not finish ([cause]), or a graph's state could not be recorded
// in the lock ([unrecorded]), so nothing more was written. With the lock kept
// ([locked]), starts are refused until a recovery brings the graphs back;
// without one, a marker ([marked], read back as [marker]) refuses them until
// the way back it records is taken, or the import is given up. On a full disk
// ([full]) the way on starts with making room: a recovery writes too.
function incompleteImport(error, cause, { unrecorded, locked, marked, copy, inputDir, targetMode, full, marker, setAsideError }) {
  const detail = error?.message ?? String(error);
  const why = cause === error ? '' : cause?.message ?? String(cause);
  const [where, whereEn] = locked ? ['记进数据库维护锁', ' in the maintenance lock'] : ['记下来', ''];
  const [stopped, stoppedEn] = unrecorded
    ? [`没能把各图谱的进度${where}${why ? `（${why}）` : ''}，所以没有接着写，也没有退回`,
      `the progress of each graph could not be recorded${whereEn}${why ? ` (${why})` : ''}, so nothing more was written or rolled back`]
    : [`自动退回没有做完（${why}）`, `its automatic rollback did not finish (${why})`];
  const [room, roomEn] = full ? roomWords(full) : ['', ''];
  const command = copy ? graphImportCommand(copy, targetMode) : null;
  const [hold, holdEn] = locked
    ? [`维护锁留着，FULI 不会在写了一半的图谱上启动。${room}运行 ${RECOVER}：它先说明怎样把图谱恢复到导入前，确认后再做。`,
      `The maintenance lock is kept, so FULI does not start on a half-written graph. ${roomEn}Run \`${RECOVER}\`: it says how it brings the graphs back to before the import, and does it once you confirm.`]
    : marked
      ? [`FULI 记下了这次导入没有完成，在把图谱导回之前不会启动。${room}`,
        `FULI recorded that this import did not finish and does not start before the graph is brought back. ${roomEn}`]
      : [`图服务没有重新启动；把图谱导回之前不要启动 FULI。${room}`, `The graph services were not started again; do not start FULI before the graph is brought back. ${roomEn}`];
  const [back, backEn] = marked && marker?.readable
    ? markedWayBack(marker, targetMode, setAsideError)
    : backWords({ locked, copy, command, inputDir, targetMode });
  return Object.assign(new AggregateError([error, cause], `导入没有成功：${detail}；${stopped}。${hold}${back}`
    + ` / Graph import failed: ${detail}; ${stoppedEn}. ${holdEn}${backEn}`), { code: 'graph_import_incomplete', lockKept: locked });
}

// The way back from this import's own copy (the lock's, or a runtime that guards nothing).
function backWords({ locked, copy, command, inputDir, targetMode }) {
  // Without a lock and without a copy (every graph was empty before), only a whole import makes the graph whole.
  const again = !locked && !copy && inputDir ? graphImportCommand(inputDir, targetMode) : null;
  return copy
    ? [`导入前的副本在 ${copy}，${locked ? '也可以' : ''}用 ${command} 导回。`,
      ` The graph from before the import is kept at ${copy}; ${locked ? 'it can also be brought back' : 'bring it back'} with: ${command}`]
    : again
      ? [`导入前图谱是空的，没有副本；重新运行这次导入让它完整：${again}。`, ` The graph was empty before the import, so there is no copy; run the import again to make it whole: ${again}`]
      : ['', ''];
}

// The way back the marker records (unfinished-import.js), the same one a
// refused start names, and giving the import up when that does not work. A
// graph that was empty before and could not be emptied again ([setAsideError])
// says why first (what holds it, when FULI can tell): giving the import up
// empties it once that is dealt with, while importing again would fail the
// same way when the backup itself cannot be read.
function markedWayBack(marker, mode, setAsideError) {
  const way = unfinishedImportWayBack(marker);
  const command = way ? graphImportCommand(way.path, mode) : null;
  const graphs = marker.partial;
  const abandon = abandonImportCommand(mode);
  const [gave, gaveEn] = [`FULI 把可能只写了一半的图谱${graphs.length ? ` ${graphs.join('、')} ` : ''}挪开（不删除）、清掉这条记录，之后${graphs.length ? '它是空的' : '图谱保持现在的数据'}`,
    `FULI moves the graph that may be half written${graphs.length ? ` (${graphs.join(', ')})` : ''} aside (not deleted) and clears this record; ${graphs.length ? 'it is empty afterwards' : 'the graph keeps the data it has now'}`];
  if (setAsideError) {
    const holders = setAsideError.holders ?? [];
    const [held, heldEn] = holders.length
      ? [`；还有进程在用它的目录：${holders.map(({ pid, name }) => `${pid}（${name ?? '?'}）`).join('、')}，先结束它（${killCommand(holders.map(({ pid }) => pid))}）`,
        `; processes still use its directory: ${holders.map(({ pid, name }) => `${pid} (${name ?? '?'})`).join(', ')}; end them first (\`${killCommand(holders.map(({ pid }) => pid))}\`)`]
      : ['', ''];
    return [`图谱 ${setAsideError.graph} 导入前是空的，这次没能把写了一半的库挪开（${setAsideError.detail}）${held}。${holders.length ? '之后' : '处理好之后'}运行 ${abandon} 放弃这次导入：${gave}。${command ? `也可以重新导入：${command}。` : ''}`,
      ` The ${setAsideError.graph} graph was empty before the import, and its half-written database could not be moved aside this time (${setAsideError.detail})${heldEn}. ${holders.length ? 'Then' : 'Once that is dealt with,'} give the import up with \`${abandon}\`: ${gaveEn}.${command ? ` Importing again also works: ${command}` : ''}`];
  }
  const [first, firstEn] = !way ? ['', '']
    : way.kind === 'copy'
      ? [`导入前的副本在 ${way.path}，用 ${command} 导回。`, ` The graph from before the import is kept at ${way.path}; bring it back with: ${command}.`]
      : [`导入前的副本里没有图谱 ${graphs.join('、')}（导入前它是空的，或者没有副本），重新运行那次导入让它完整：${command}。`,
        ` No copy from before the import holds the ${graphs.join(' and ')} graph (it was empty then, or there is no copy); run that import again to make it whole: ${command}.`];
  return [`${first}${first ? '这样走不通时（比如那份备份本身读不了），' : ''}可以放弃这次导入：${abandon}，${gave}。`,
    `${firstEn}${firstEn ? ' If that does not work (the backup itself cannot be read, say),' : ''} give the import up: \`${abandon}\`; ${gaveEn}.`];
}

// "先腾出磁盘空间：…" for a full disk, with the copy's size and the space free now.
function roomWords({ copyBytes, freeBytes }) {
  const free = freeBytes === null ? ['', ''] : [`现在剩 ${byteSize(freeBytes)}`, `${byteSize(freeBytes)} is free now`];
  if (copyBytes === null) {
    return [`磁盘满了：先腾出一些磁盘空间${free[0] ? `（${free[0]}）` : ''}，再做下一步。`,
      `The disk is full: first free some disk space${free[1] ? ` (${free[1]})` : ''}, then take the next step. `];
  }
  return [`磁盘满了：先腾出磁盘空间，至少要有导入前副本大小的两倍（副本 ${byteSize(copyBytes)}，至少要 ${byteSize(2 * copyBytes)}${free[0] ? `，${free[0]}` : ''}），再做下一步。`,
    `The disk is full: first free disk space, at least twice the size of the copy from before the import (the copy is ${byteSize(copyBytes)}, so at least ${byteSize(2 * copyBytes)}${free[1] ? `; ${free[1]}` : ''}), then take the next step. `];
}

// An import refused because an earlier unfinished one may have left [lacking]
// half written and this backup does not hold it, with the way back.
function leftHalfWritten(lacking, earlier, mode) {
  const back = unfinishedImportWayBack(earlier);
  const command = back ? graphImportCommand(back.path, mode) : null;
  const [way, wayEn] = command
    ? [`先用 ${command} 让图谱完整。`, ` Make the graph whole first with: ${command}`]
    : ['', ''];
  return Object.assign(new Error(`没有导入：上次没有完成的导入可能把图谱 ${lacking.join('、')} 只写入了一半，这份备份里没有它，导入后它还是残缺的；什么都没有改动。${way}`
    + ` / Not imported: an earlier unfinished import may have left the ${lacking.join(' and ')} graph half written, and this backup does not hold it, so it would stay half written; nothing was changed.${wayEn}`),
  { code: 'graph_import_unfinished' });
}

export async function readGraphBackupManifest(inputDir) {
  const root = requiredPath(inputDir, 'Backup input directory');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error('Backup manifest is missing or invalid.', { cause: error });
  }
  if (manifest?.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new Error('Backup format or version is not supported.');
  }
  validateMode(manifest.sourceMode, 'backup source mode');
  validateManifestInstances(manifest.instances);
  validateSelection(manifest.selection);
  return manifest;
}

// A backup's manifest, once every file it names matches its checksum.
export async function readVerifiedGraphBackup(inputDir) {
  const manifest = await readGraphBackupManifest(inputDir);
  await verifyBackupFiles(inputDir, manifest);
  return manifest;
}

async function verifyBackupFiles(root, manifest) {
  for (const entry of manifest.instances) {
    const actual = await sha256File(join(root, entry.file));
    if (actual !== entry.sha256) {
      throw new Error(`Backup checksum validation failed for ${entry.id}.`);
    }
  }
}

function validateManifestInstances(instances) {
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new Error('Backup manifest does not contain graph instances.');
  }
  const ids = validateInstances(instances.map(({ id }) => id));
  if (ids.length !== instances.length) throw new Error('Backup instances are invalid.');
  for (const entry of instances) {
    if (
      entry.file !== `${entry.id}.dump` ||
      basename(entry.file) !== entry.file ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`Backup entry for ${entry.id} is invalid.`);
    }
  }
}

function validateSelection(selection) {
  if (selection === undefined) return;
  if (
    !selection ||
    typeof selection !== 'object' ||
    Object.keys(selection).some((key) => key !== 'personalSpaceId') ||
    typeof selection.personalSpaceId !== 'string' ||
    !selection.personalSpaceId.trim() ||
    selection.personalSpaceId.length > 200 ||
    /[\s\u0000-\u001f\u007f]/u.test(selection.personalSpaceId)
  ) {
    throw new Error('Backup personal-space selection is invalid.');
  }
}

function selectionProperty(selection) {
  if (selection == null) return {};
  validateSelection(selection);
  return { selection };
}

function validateInstances(instances) {
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new TypeError('At least one graph instance is required.');
  }
  const normalized = [...new Set(instances)];
  if (
    normalized.length !== instances.length ||
    normalized.some((id) => !['personal', 'workspace'].includes(id))
  ) {
    throw new TypeError('Graph instances must be unique personal or workspace entries.');
  }
  return normalized;
}

function validateMode(mode, label) {
  if (!['container', 'native'].includes(mode)) {
    throw new TypeError(`${label} must be container or native.`);
  }
}

function assertAdapter(adapter, methods) {
  if (!adapter || methods.some((method) => typeof adapter[method] !== 'function')) {
    throw new TypeError('A complete graph backup runtime adapter is required.');
  }
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  return resolve(value);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
