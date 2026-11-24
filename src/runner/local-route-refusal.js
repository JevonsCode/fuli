import { OWN_DATA_SPACE } from './follower-local-runtime.js';
import { DEFAULT_SCOPE, GLOBAL_SCOPE, PROJECT_PREFIX } from './routes-store.js';

// Why `fuli routes local SCOPE` does not make that scope this computer's yet
// (docs/runner-roles-design.md §11, step 3a), each with what the person can
// do now. Making a project local opens with step 3c; until then nothing is
// routed to this computer, so no scope ever has two writers.
//
// hostProjects: the ids of the projects this computer knows belong to the
// host (call-routes.js projectOwners: answered there, or routed there).
// localRuntime: this computer's own runtime (follower-local-runtime.js).
// Answers { code, message }, both languages in the message.
export function localRouteRefusal({ scope, hostName = 'the host', hostProjects = [], localRuntime }) {
  if (scope === GLOBAL_SCOPE) {
    return refusal('global_has_one_owner',
      '`global`（你的习惯、个人档案、FLA 名册和 Jefa 的看板）只有一个所有者，就是你跟随的电脑；跟随别人的电脑永远不拥有它。不用做什么。',
      '`global` (your habits, profile, the FLA roster and Jefa\'s board) has one owner, the computer you follow; '
      + 'a computer that follows another never owns it (docs/runner-roles-design.md D1, D2). Nothing to do.');
  }
  if (scope === DEFAULT_SCOPE) {
    return refusal('default_stays',
      `\`default\` 决定新项目文件夹归哪台电脑，现在是 ${hostName}，这一步不改它。之后可以把单个新项目设为本机。`,
      `\`default\` says where new project folders go, ${hostName} now, and it stays so. Making one new project this `
      + 'computer\'s opens in a later step.');
  }
  const id = scope.slice(PROJECT_PREFIX.length);
  if (hostProjects.includes(id)) {
    return refusal('project_on_host',
      `项目 ${id} 在 ${hostName} 上已经有了。把已有项目搬到这台电脑是之后的步骤（设计 §7）；现在它照常跟随 ${hostName}，不用做什么。`,
      `Project ${id} is already on ${hostName}. Moving a project that exists to this computer is a later step `
      + `(docs/runner-roles-design.md §7); it keeps following ${hostName} as it does, with nothing to do.`);
  }
  // FULI data of this computer's own, under another space than the host's (an `existing` graph among them).
  if (localRuntime?.space?.state === 'different') return refusal('local_space_differs', OWN_DATA_SPACE.zh, OWN_DATA_SPACE.en);
  if (localRuntime?.state !== 'ready') {
    const missing = RUNTIME_MISSING[localRuntime?.state === 'failed' && localRuntime.code === 'disk_low' ? 'disk_low'
      : localRuntime?.state ?? 'not_prepared'] ?? RUNTIME_MISSING.not_prepared;
    return refusal('local_runtime_not_ready', `这台电脑自己的运行时还没准备好：${missing.zh}`,
      `This computer's own runtime is not ready: ${missing.en}`);
  }
  return refusal('local_route_not_yet',
    `这台电脑的运行时已准备好，但把项目设为本机还没开放（之后的版本）。现在项目 ${id} 跟随 ${hostName}；\`fuli routes list\` 列出每个项目归哪台电脑。`,
    `This computer's own runtime is ready, but making a project this computer's is not open yet (a later version). `
    + `Project ${id} follows ${hostName} for now; \`fuli routes list\` shows which computer each project belongs to.`);
}

const RUNTIME_MISSING = {
  not_prepared: { zh: '还没开始准备。启动这台电脑上的 FULI（打开 FULI.app 或 `fuli start`），会在后台准备。',
    en: 'it was never prepared. Start FULI here (FULI.app, or `fuli start`); it is prepared in the background.' },
  preparing: { zh: '正在后台准备，好了以后 `fuli status` 会说。不用做什么。',
    en: 'it is being prepared in the background; `fuli status` says when it is ready. Nothing to do.' },
  disk_low: { zh: '磁盘空间不够。腾出空间后，在本机控制台点「重新准备」，或再运行一次 `fuli start`。',
    en: 'there is not enough free disk space. Free some, then press 「重新准备 / Prepare again」 on this computer\'s console, '
      + 'or run `fuli start` again.' },
  failed: { zh: '上次准备没有成功（原因在数据目录的 logs/runner-local-runtime.log）。在本机控制台点「重新准备」。',
    en: 'the last preparation did not succeed (logs/runner-local-runtime.log in the data directory says why). Press '
      + '「重新准备 / Prepare again」 on this computer\'s console.' }
};

function refusal(code, zh, en) {
  return { code, message: `${en}\n${zh}` };
}
