import { localSpaceLine, OWN_DATA_SPACE } from './follower-local-runtime.js';
import { DEFAULT_SCOPE, GLOBAL_SCOPE, PROJECT_PREFIX } from './routes-store.js';

// Whether this computer, on its own, may own SCOPE (docs/runner-roles-design.md
// §11, steps 3b and 3c): null for a project the host is not known to have,
// while this computer's own runtime is ready under the host's space; else why
// not, with what the person can do now. What the host must say besides (it
// takes writes to global, its first copy of global arrived, it has no such
// project) is make-project-local.js's to ask, which every way of making a
// project this computer's goes through.
//
// hostProjects: the ids of the projects this computer knows belong to the
// host (call-routes.js projectOwners: answered there, or routed there).
// localRuntime: this computer's own runtime (follower-local-runtime.js).
// Answers null, or { code, message }, both languages in the message.
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
  // Made under the host's space only once the host said it: a project here before then would be in another space.
  if (localRuntime.space?.state !== 'same') {
    const line = localSpaceLine(localRuntime) ?? localSpaceLine({ space: { state: 'later' } });
    return refusal('local_space_not_yet', `${line.zh}建好以后才能把项目放在这台电脑上。`,
      `${line.en} A project can be kept on this computer once it is.`);
  }
  return null;
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
