import { ApplicationError } from '../app/application-error.js';

// Why an FLA may not make a console change for the person (rec#11 D-81), in
// the person's two languages: the Agent shows the message as it is.
const LOCAL_ONLY = '这一项只能由你本人在这台电脑上操作，任何权限都不会把它交给 FLA。 / '
  + 'Only you make this change, on this computer; no AI permission opens it to an FLA.';
const CATEGORY_OFF = '这一类已被你收回：在 设置 › AI 权限 打开后 FLA 才能代你做。 / '
  + 'This category was taken back by you; turn it on in Settings › AI permissions.';
const ACCESS_OFF = 'Agent 使用已关闭：在 设置 › 访问 打开。 / Agent access is off; turn it on in Settings › Access.';

// The catalog entry an FLA may run for the person, or the refusal that says why not.
export function delegableEntry(entry) {
  if (!entry || entry.access === 'local_user_only') {
    throw new ApplicationError('local_user_only', LOCAL_ONLY, { status: 403 });
  }
  if (entry.access === 'agent') {
    const tools = entry.toolNames ?? [entry.toolName];
    throw new ApplicationError('agent_tool_route', `Call the Agent tool ${tools.join(' or ')} for ${entry.route} instead.`,
      { status: 400 });
  }
  return entry;
}

export function categoryOffRefusal() {
  return new ApplicationError('delegation_category_off', CATEGORY_OFF, { status: 403 });
}

export function agentAccessOffRefusal() {
  return new ApplicationError('agent_access_disabled', ACCESS_OFF, { status: 403 });
}
