import { isRunnerDataDirectory } from '../runner/runner-mode.js';

// The commands that start this computer's own graph runtime as an ordinary FULI's, or write
// its graph (`fuli graph import/export`, `fuli graph runtime …`, `fuli graph migrate`,
// `fuli migrate`), refuse on a computer that follows a host, before anything is stopped,
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
  zh: '本机运行时坏了时，在这台电脑的控制台页面按「重新准备」；还是不行，`fuli runner leave` 会把装着副本的图谱挪到 '
    + '`native-runtime/recovered/`（不删除），这台电脑就成了自己的 FULI，`fuli graph runtime recover` 在这里照常可用。'
    + '只看恢复计划（`--preview`）不受影响。',
  en: 'When this computer\'s own runtime is broken, press 「重新准备 / Prepare again」 on this computer\'s console page. If '
    + 'that does not help, `fuli runner leave` sets the graph holding the copy aside in `native-runtime/recovered/` (not '
    + 'deleted) and makes this a FULI of its own, where `fuli graph runtime recover` works as usual. Looking at the '
    + 'recovery plan (`--preview`) is not refused.'
};

export function refuseOnFollower(dataDir, command, { isRunner = isRunnerDataDirectory, recover = false } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || !isRunner(dataDir)) return;
  const next = recover ? RECOVER_NEXT : NEXT;
  throw Object.assign(new Error(`${command}：${WHY.zh}${next.zh}\n${command}: ${WHY.en} ${next.en}`),
    { code: 'follower_graph_managed' });
}
