import { receiptText } from '../agents/identity-receipt.js';
import { sessionTaskContext } from './task-entry-standing-owner.js';

// rec#110 item 9: within one session the FLA that owns a task can change
// between two tasks, most often because the working directory moved to
// another project. The entry then says so once, to the Agent and in the
// receipt, and names how to keep the earlier FLA (#FLA binds one across
// folders, task-entry-named-fla.js). The earlier FLA's records stay in their
// own scope; nothing is copied.

const GUIDANCE = 'This session\'s FLA changed: from this task on, to_agent_id owns the work. Tell the person once '
  + '(the receipt notice says it). The earlier FLA\'s records stay in its scope and are not copied: carry what this '
  + 'task needs from this conversation into your own checkpoint workLog. To keep the earlier FLA, the person starts '
  + 'a message with #FLA and its name.';

// The FLA and project of the session's current task, as the session itself
// holds them (a standing assignment's route keeps the session where it was).
export function sessionOwnerOf(task) {
  const context = sessionTaskContext(task);
  if (!context?.projectAgentId) return null;
  return { agentId: context.projectAgentId, personalProjectId: context.personalProjectId ?? null };
}

// The owner_change field and receipt notice, or null when the owner stays.
// A named FLA, a group discussion or a standing assignment already says why
// the owner is who it is, so it adds nothing then.
export async function ownerChangeEntry(application, resolution, selection, toName) {
  const from = resolution.sessionOwner;
  const to = selection?.agent?.agentId ?? null;
  if (!from || !to || from.agentId === to || resolution.fla || resolution.group || resolution.standingOwner) return null;
  const fromName = await agentName(application, from) ?? from.agentId;
  const toLabel = toName ?? to;
  return {
    field: { from_agent_id: from.agentId, from_project_id: from.personalProjectId, to_agent_id: to,
      to_project_id: resolution.personalProjectId ?? null, guidance: GUIDANCE },
    receiptNotice: receiptText(`本会话上一个任务由 ${fromName} 负责，这次起由 ${toLabel} 负责；`
      + `要继续由 ${fromName} 负责，消息开头写 #FLA ${fromName}`)
  };
}

// The earlier FLA's name; its ID when it cannot be read (archived, or the Provider is away).
async function agentName(application, owner) {
  try {
    const agent = await application.getProjectAgent({ personalSpaceId: application.config.personal.spaceId,
      personalProjectId: owner.personalProjectId, agentId: owner.agentId });
    return agent?.profile?.displayName || agent?.profile?.name || null;
  } catch {
    return null;
  }
}
