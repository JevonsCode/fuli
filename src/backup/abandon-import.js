import { killCommand } from '../text/terminal-command.js';
import { asideWords } from './graph-backup.js';
import {
  abandonImportCommand,
  graphImportCommand,
  latestImportCopy,
  markerMoveCommand
} from './unfinished-import.js';

// Giving up an unfinished import into a runtime with no lifecycle lock
// (`fuli graph abandon-import`): the last way out when importing the graph
// back does not work (the backup cannot be read, a file is held). Each graph
// its marker says may be half written moves aside, never deleted
// (adapter.setAside: the native recovery folder, or recovered-<time>/ in the
// container's volume), so it is empty; then the marker goes and FULI starts
// again. Graphs the import never touched, or wrote whole, stay as they are.
// The copy from before the import stays where it is.
//
// A graph that cannot be moved keeps the marker: the words say what holds it
// when FULI can tell, and, as the very last way out, where the marker is and
// how to move it away by hand, and what that means.
export async function abandonUnfinishedImport({ adapter, targetMode, paths }) {
  const marker = typeof adapter.unfinishedImport === 'function' ? await adapter.unfinishedImport() : null;
  if (!marker) return { status: 'nothing', targetMode };
  if (!marker.readable) throw unreadableMarker(marker, paths, targetMode);
  const graphs = marker.partial.filter(id => !Array.isArray(adapter.instances) || adapter.instances.includes(id));
  await adapter.stop();
  const asides = [];
  const failures = [];
  for (const graph of graphs) {
    try { asides.push({ graph, ...await adapter.setAside(graph) }); }
    catch (error) { failures.push({ graph, detail: String(error?.message ?? error), holders: error?.holders ?? [] }); }
  }
  if (failures.length) throw notAbandoned(failures, marker, targetMode, asides);
  await adapter.clearUnfinishedImport();
  return { status: 'abandoned', targetMode, graphs, asides, copy: marker.copy,
    words: abandonedWords(graphs, asides, marker, targetMode) };
}

function abandonedWords(graphs, asides, marker, mode) {
  const moved = asideWords(asides, '可能只写了一半，已经清空', 'may have been half written and is empty now');
  const [state, stateEn] = graphs.length
    ? ['', '']
    : ['图谱里是那次导入写完的新数据，只是没有核对图谱身份。', " The graph holds that import's data whole; only its identity was not reconciled."];
  const [copy, copyEn] = marker.copy
    ? [`导入前的副本还在 ${marker.copy}，需要时可以导回：${graphImportCommand(marker.copy, mode)}。`,
      ` The copy from before the import is still at ${marker.copy}; bring it back when you need it: ${graphImportCommand(marker.copy, mode)}`]
    : ['', ''];
  return `已放弃那次没完成的导入，清掉了它的记录，FULI 可以启动了。${state}${moved.map(([zh]) => zh).join('')}${copy}`
    + ` / The unfinished import was given up and its record cleared; FULI can start again.${stateEn}${moved.map(([, en]) => en).join('')}${copyEn}`;
}

// The last way out, said whenever FULI cannot give the import up itself.
function byHand(marker, mode, back) {
  const move = markerMoveCommand(marker);
  return [`最后的办法是手动把这条记录挪走（标记文件是 ${marker.path}）：${move}。这样 FULI 就会启动，但不保证图谱完整${back ? `，所以先用导入前的副本导回：${back}` : ''}。`,
    ` The very last way out is to move this record away by hand (the marker file is ${marker.path}): \`${move}\`. FULI then starts, but the graph is not known to be whole${back ? `, so bring the copy from before the import back first: ${back}` : ''}.`];
}

function notAbandoned(failures, marker, mode, asides) {
  const why = failures.map(({ graph, detail, holders }) => {
    const pids = holders.map(({ pid }) => pid);
    return holders.length
      ? [`图谱 ${graph} 没能挪开（${detail}）；还有进程在用它的目录：${holders.map(({ pid, name }) => `${pid}（${name ?? '?'}）`).join('、')}，先结束它（${killCommand(pids)}）`,
        `the ${graph} graph could not be moved (${detail}); processes still use its directory: ${holders.map(({ pid, name }) => `${pid} (${name ?? '?'})`).join(', ')}; end them first (\`${killCommand(pids)}\`)`]
      : [`图谱 ${graph} 没能挪开（${detail}）`, `the ${graph} graph could not be moved (${detail})`];
  });
  const moved = asideWords(asides, '已经清空', 'is empty now');
  const back = marker.copy ? graphImportCommand(marker.copy, mode) : null;
  const [last, lastEn] = byHand(marker, mode, back);
  const abandon = abandonImportCommand(mode);
  return Object.assign(new Error(`没有放弃那次导入：${why.map(([zh]) => zh).join('；')}。这条记录还在，FULI 仍然不会启动。${moved.map(([zh]) => zh).join('')}处理好之后再运行 ${abandon}。${last}`
    + ` / The import was not given up: ${why.map(([, en]) => en).join('; ')}. Its record stays and FULI still does not start.${moved.map(([, en]) => en).join('')} Once that is dealt with, run \`${abandon}\` again.${lastEn}`),
  { code: 'graph_import_unfinished' });
}

// A marker that cannot be read names no graph and no copy: FULI does not
// guess which graph to empty, so it gives nothing up and says the way by hand.
export function unreadableMarker(marker, paths, mode) {
  const latest = latestImportCopy(paths);
  const back = latest ? graphImportCommand(latest, mode) : null;
  const [last, lastEn] = byHand(marker, mode, back);
  return Object.assign(new Error(`没有放弃那次导入：记录它的文件 ${marker.path} 坏了，读不出来，FULI 不知道哪个图谱可能只写了一半，所以不敢启动，也不替你挪动图谱。${last}`
    + ` / The import was not given up: the file recording it, ${marker.path}, is damaged and cannot be read, so FULI cannot tell which graph may be half written; it does not start, and it moves no graph for you.${lastEn}`),
  { code: 'graph_import_unfinished' });
}
