import { ApplicationError } from '../app/application-error.js';

// Why an FLA may not make a console change for the person (rec#11 D-81), in
// the person's two languages: the Agent shows the message as it is.
const LOCAL_ONLY = '这一项只能由你本人在这台电脑上操作，任何权限都不会把它交给 FLA。 / '
  + 'Only you make this change, on this computer; no AI permission opens it to an FLA.';
const CATEGORY_OFF = '这一类已被你收回：在 设置 › AI 权限 打开后 FLA 才能代你做。 / '
  + 'This category was taken back by you; turn it on in Settings › AI permissions.';
const ACCESS_OFF = 'Agent 使用已关闭：在 设置 › 访问 打开。 / Agent access is off; turn it on in Settings › Access.';
const WORDS_NOT_FOUND = '在你这个会话最近的消息里没有找到这句话：FLA 要先在对话里问你，再原样转达你的话。 / '
  + 'These words are not in your recent messages of this session; the FLA asks you in chat first and passes your exact words.';
const WORDS_REQUIRED = '这是你本人的决定：FLA 要先在对话里问你，再把你的原话作为 personWords 转达。 / '
  + 'This is your own decision; the FLA asks you in chat first and passes your exact words as personWords.';

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

// A relayed decision (rec#80) without the person's words, or with words FULI
// does not find in their recent messages of the calling session.
export function personWordsRequiredRefusal() {
  return new ApplicationError('person_words_required', WORDS_REQUIRED, { status: 400 });
}

export function personWordsNotFoundRefusal() {
  return new ApplicationError('person_words_not_found', WORDS_NOT_FOUND, { status: 403 });
}

export function agentAccessOffRefusal() {
  return new ApplicationError('agent_access_disabled', ACCESS_OFF, { status: 403 });
}
