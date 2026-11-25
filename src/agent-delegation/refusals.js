import { ApplicationError } from '../app/application-error.js';

// Why an FLA may not make a console change for the person (rec#11 D-81), in
// the person's two languages: the Agent shows the message as it is.
const LOCAL_ONLY = '这一项只能由你本人在这台电脑上操作，任何权限都不会把它交给 FLA。 / '
  + 'Only you make this change, on this computer; no AI permission opens it to an FLA.';
// Each category's switch as Settings › What AI may do names it (web i18n agent-delegation.ts, settings.ts tabs.ai).
const CATEGORY_NAMES = Object.freeze({
  settings: ['设置', 'Settings'], organisation: ['组织', 'Organisation'], projects: ['项目', 'Projects'],
  services_apps: ['服务与 Agent App', 'Services and apps'], roundtable: ['圆桌', 'Roundtable'],
  decisions: ['转达你的决定', 'Relay your decisions'], lan_roundtable: ['局域网圆桌', 'LAN roundtable'],
  model_settings: ['内置 Agent 模型', 'Built-in Agent models'], public_projects: ['公开分享看板', 'Public board sharing']
});
const ACCESS_OFF = 'Agent 使用已关闭：在 设置 › AI 能做什么 › Agent 使用 打开。 / Agent access is off; turn it on in Settings › What AI may do › Agent access.';
// The page that turns it on, as a whole address: the person reads this in a chat, where a link is the way there.
const settingsLink = (consoleUrl) => (consoleUrl ? ` ${consoleUrl}/settings?tab=ai` : '');
const WORDS_NOT_FOUND = '在你这个会话最近的消息里没有找到这句话：FLA 要先在对话里问你，再原样转达你的话。 / '
  + 'These are not whole sentences from your recent messages of this session; the FLA asks you in chat first and passes your exact words.';
const CASE_NOT_IN_WORDS = '你的原话里没有这句适用情况：原话里要包含这句适用情况，FLA 要转达你勾选或写下的那一项原文。 / '
  + 'Your words do not contain this case: they must include it, so the FLA passes the exact option you picked or wrote.';
const WORDS_REQUIRED = '这是你本人的决定：FLA 要先在对话里问你，再把你的原话作为 personWords 转达。 / '
  + 'This is your own decision; the FLA asks you in chat first and passes your exact words as personWords.';
const REUSE_INSTRUCTION_NOT_FOUND = '这段话不是在说「下次也这样做」：只保留你本人这次明确要求下次照做的话；其他话、否定说法、提问、举例和引用的说法都不算。 / '
  + 'These words are not an affirmative instruction to do it this way next time; other wording, a negation, a question, a cited example or a quoted phrase does not keep a lesson.';
const DELIVERY_NOT_COMPLETED = '「下次也这样做」要对应一次已经完成并记录的交付：这个项目里这条会话还没有完成的检查点，或者它不属于你所在的这个项目／FLA。完成并记录这次交付后，再保留下次的做法；也可以把那次交付的会话 ID 作为 deliveryRef 传进来。 / '
  + '“Do it this way next time” needs a completed, recorded delivery: this conversation has no completed checkpoint in this project, or it is not in this project for this FLA. Record this delivery first, then keep the way it worked; an explicit deliveryRef names that delivery\'s conversation.';

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

// Names the one switch to turn on, so the Agent can tell the person exactly where (rec#123).
export function categoryOffRefusal(category, consoleUrl = null) {
  const [zh, en] = CATEGORY_NAMES[category];
  return new ApplicationError('delegation_category_off', `这一类已被你收回：在 设置 › AI 能做什么 › ${zh} 打开后 FLA 才能代你做。 / `
    + `This category was taken back by you; turn it on in Settings › What AI may do › ${en}.${settingsLink(consoleUrl)}`, { status: 403 });
}

// A relayed decision (rec#80) without the person's words, or with words FULI
// does not find in their recent messages of the calling session.
export function personWordsRequiredRefusal() {
  return new ApplicationError('person_words_required', WORDS_REQUIRED, { status: 400 });
}

export function personWordsNotFoundRefusal() {
  return new ApplicationError('person_words_not_found', WORDS_NOT_FOUND, { status: 403 });
}

// A workflow lesson needs the person's own affirmative "do it this way next
// time". A bare thanks, a negation, an older quote or an example proves nothing.
export function reuseInstructionNotFoundRefusal() {
  return new ApplicationError('person_words_not_found', REUSE_INSTRUCTION_NOT_FOUND, { status: 403 });
}

// A lesson must name a delivery that was actually completed and recorded in
// this FLA's project; free-form evidence is not proof.
export function deliveryNotCompletedRefusal() {
  return new ApplicationError('delivery_not_completed', DELIVERY_NOT_COMPLETED, { status: 409 });
}

// A relayed case for a habit (appliesWhen) that the person's words do not contain.
export function caseNotInPersonWordsRefusal() {
  return new ApplicationError('person_words_not_found', CASE_NOT_IN_WORDS, { status: 403 });
}

export function agentAccessOffRefusal(consoleUrl = null) {
  return new ApplicationError('agent_access_disabled', `${ACCESS_OFF}${settingsLink(consoleUrl)}`, { status: 403 });
}
