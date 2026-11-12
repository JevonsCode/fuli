import { setTimeout as delay } from 'node:timers/promises';

import { receiptText } from '../agents/identity-receipt.js';
import { sessionTaskContext } from './task-entry-standing-owner.js';

// rec#110 item 9: within one session the FLA that owns a task can change
// between two tasks, most often because the working directory moved to
// another project. The entry then says so once, to the Agent and in the
// receipt, and names how to keep the earlier FLA (#FLA binds one across
// folders, task-entry-named-fla.js). The earlier FLA's records stay in their
// own scope; nothing is copied. The notice rides on the task as a route
// marker, so the checkpoint receipt that replaces the entry's says it too.

const GUIDANCE = 'This session\'s FLA changed: from this task on, to_agent_id owns the work. Tell the person once '
  + '(the receipt notice says it). The earlier FLA\'s records stay in its scope and are not copied: carry what this '
  + 'task needs from this conversation into your own checkpoint workLog. To keep the earlier FLA, the person starts '
  + 'a message with #FLA and its name.';

// The earlier FLA's name is only for display: it is read beside the entry's
// other reads and given up after this long, leaving its ID (DOT on #875).
const NAME_WAIT_MS = 300;
const MARKER = /^owner_change:(\S+) (.+)$/su;

// How this task's project was found, said beside the change (rec#125), so a
// switch by repository address is not silent. Other bases add nothing.
const BASIS_LABELS = Object.freeze({
  git_remote: { 'zh-CN': '按仓库地址', 'en-US': 'by repository address' },
  repository_root: { 'zh-CN': '按仓库目录名', 'en-US': 'by repository folder name' },
  directory_name: { 'zh-CN': '按目录名', 'en-US': 'by folder name' },
  git_worktree_origin: { 'zh-CN': '按 worktree 原仓库名', 'en-US': 'by the worktree\'s original repository' },
  workspace_child: { 'zh-CN': '按工作区里的项目目录', 'en-US': 'by a project folder in the workspace' },
  registered_repository: { 'zh-CN': '按刚登记的仓库', 'en-US': 'by the repository just registered' },
  named_in_prompt: { 'zh-CN': '按消息里的项目名', 'en-US': 'by the project named in the message' }
});

function basisLabel(basis) {
  return BASIS_LABELS[String(basis ?? '').replace(/_case_insensitive$/u, '')] ?? null;
}

// The FLA and project of the session's current task, as the session itself
// holds them (a standing assignment's route keeps the session where it was).
export function sessionOwnerOf(task) {
  const context = sessionTaskContext(task);
  if (!context?.projectAgentId) return null;
  return { agentId: context.projectAgentId, personalProjectId: context.personalProjectId ?? null };
}

// The earlier owner when this entry changes it, or null when the owner stays.
// A named FLA, a group discussion or a standing assignment already says why
// the owner is who it is, so it adds nothing then.
export function changedOwner(resolution, selection) {
  const from = resolution.sessionOwner;
  const to = selection?.agent?.agentId ?? null;
  if (!from || !to || from.agentId === to || resolution.fla || resolution.group || resolution.standingOwner) return null;
  return from;
}

// The earlier FLA's name, or null: never longer than NAME_WAIT_MS, never a failure.
export async function previousOwnerName(application, from) {
  if (!from) return null;
  const read = application.getProjectAgent({ personalSpaceId: application.config.personal.spaceId,
    personalProjectId: from.personalProjectId, agentId: from.agentId })
    .then(agent => agent?.profile?.displayName || agent?.profile?.name || null, () => null);
  return Promise.race([read, delay(NAME_WAIT_MS, null, { ref: false })]);
}

// The owner_change field, receipt notice and route marker.
export function ownerChangeEntry(from, fromName, resolution, to, toName) {
  const fromLabel = fromName ?? from.agentId;
  const label = basisLabel(resolution.basis);
  const projectId = resolution.personalProjectId ?? null;
  const basis = label ? `（${label['zh-CN']}${projectId ? `匹配到项目 ${projectId}` : ''}）` : '';
  const notice = `本会话上一个任务由 ${fromLabel} 负责，这次起由 ${toName ?? to} 负责${basis}；要继续由 ${fromLabel} 负责，消息开头写 #FLA ${fromLabel}`;
  return {
    field: { from_agent_id: from.agentId, from_project_id: from.personalProjectId, to_agent_id: to,
      to_project_id: projectId, ...(label ? { basis: resolution.basis, basis_text: label['en-US'] } : {}),
      guidance: GUIDANCE },
    receiptNotice: receiptText(notice),
    marker: `owner_change:${from.agentId} ${notice}`
  };
}

// The checkpoint receipt repeats the notice the entry showed.
export function ownerChangeReceiptNotices(task) {
  return (task?.agentAssignment?.match_basis ?? []).map(item => MARKER.exec(item)?.[2]).filter(Boolean).map(receiptText);
}
