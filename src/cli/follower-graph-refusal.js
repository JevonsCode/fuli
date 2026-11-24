import { isRunnerDataDirectory } from '../runner/runner-mode.js';

// The commands that start this computer's own graph runtime as an ordinary FULI's, or write
// its graph (`fuli graph import/export`, `fuli graph runtime …`, `fuli graph migrate`,
// `fuli migrate reconcile-knowledge`), refuse on a computer that follows a host, before anything is stopped,
// started or written (docs/runner-roles-design.md §12): its graph holds a read-only copy of
// the host's `global`, which only FULI's own preparation and sync bring up to date, under
// the copy's rules. A start from any other path still tells the Provider it is a copy
// (global-copy.js providerGlobalReplica); this says why nothing was done and what to do.
const WHY = {
  zh: '这台电脑跟随主机，本机图谱由 FULI 自己管理（里面是主机全局的只读副本），所以这条命令在这里不做，什么都没改。',
  en: 'This computer follows a host, and FULI manages its own graph here (it holds a read-only copy of the host\'s '
    + 'global), so this command does nothing here. Nothing was changed.'
};
const NEXT = {
  zh: '要备份、导入或迁移数据，在主机上做；要让这台电脑不再跟随主机，用 `fuli runner leave`。',
  en: 'Back up, import or migrate on the host. To stop following the host, run `fuli runner leave`.'
};
// `fuli graph runtime recover`, which a broken graph runtime needs on a FULI of its own.
const RECOVER_NEXT = {
  zh: '本机运行时坏了时，这台电脑的控制台页面上有「重新准备」就按；没有的话用 `fuli runner leave`（它会把装着副本的图谱挪到 '
    + '`native-runtime/recovered/`，不删除），这台电脑就成了自己的 FULI，`fuli graph runtime recover` 在这里照常可用。'
    + '只看恢复计划（`--preview`）不受影响。',
  en: 'When this computer\'s own runtime is broken, press 「重新准备 / Prepare again」 if this computer\'s console page shows '
    + 'it. If it does not, `fuli runner leave` sets the graph holding the copy aside in `native-runtime/recovered/` (not '
    + 'deleted) and makes this a FULI of its own, where `fuli graph runtime recover` works as usual. Looking at the '
    + 'recovery plan (`--preview`) is not refused.'
};
// `fuli migrate` on a follower: its own stores (runner/*.sqlite, JSON stores, …) are migrated
// here as anywhere, and only the graph step is left out, which FULI manages.
export const FOLLOWER_MIGRATE_NOTE = '这台电脑跟随主机，本机图谱由 FULI 自己管理，这里不包含图谱。\n'
  + 'This computer follows a host; FULI manages its own graph here, so the graph is not included.';

export function followsHost(dataDir, { isRunner = isRunnerDataDirectory } = {}) {
  return typeof dataDir === 'string' && Boolean(dataDir) && isRunner(dataDir);
}

export function refuseOnFollower(dataDir, command, { isRunner = isRunnerDataDirectory, recover = false } = {}) {
  if (!followsHost(dataDir, { isRunner })) return;
  const next = recover ? RECOVER_NEXT : NEXT;
  throw Object.assign(new Error(`${command}：${WHY.zh}${next.zh}\n${command}: ${WHY.en} ${next.en}`),
    { code: 'follower_graph_managed' });
}
