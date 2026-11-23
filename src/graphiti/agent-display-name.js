import { CONSOLE_LANGUAGES, DEFAULT_CONSOLE_LANGUAGE } from '../app/console-language.js';

// What to call an FLA wherever FULI writes its name for a person or an Agent.
// A name someone gave stays as it is. Two kinds of names FULI wrote by itself
// say nothing to a person, so they are written here in the person's language:
//
// - the lead FULI hired for a project nobody named: '<generated project
//   name> 负责人' before graph/23 ('会话项目 / Conversation project 负责人'),
//   '#<number> 负责人' after it (graph-provider default_project_lead.py);
// - a specialist FULI recruited without a name: '<work_kind> Agent', an
//   internal code such as 'code_review Agent'.
//
// The stored name is left alone: it is how `#FLA <name>` and the /fla menu
// reach the FLA, so only what is shown changes. The console applies the same
// rule (web/src/features/agent-profile/agent-name.ts).

const GENERATED_PROJECT = '(?:会话项目 / Conversation project|临时任务 / Temporary task|临时会话 / Temporary session)';
const TEMPORARY_LEAD = new RegExp(`^${GENERATED_PROJECT}\\s*负责人$`, 'u');
const NUMBERED_LEAD = /^#([0-9a-f]{8}) 负责人$/u;
const WORK_KIND_AGENT = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)* Agent$/u;

const WORDS = Object.freeze({
  'zh-CN': {
    temporaryLead: '临时项目的助手', numberedLead: number => `临时项目 #${number} 的助手`,
    specialist: '专项助手', occupation: name => `${name}助手`
  },
  'en-US': {
    temporaryLead: 'Temporary project assistant', numberedLead: number => `Assistant for temporary project #${number}`,
    specialist: 'Specialist assistant', occupation: name => `${name} assistant`
  }
});

/** Whether FULI wrote this FLA name by itself, so it is shown in the person's words instead. */
export function isGeneratedAgentName(name) {
  const text = String(name ?? '').trim();
  return TEMPORARY_LEAD.test(text) || NUMBERED_LEAD.test(text) || WORK_KIND_AGENT.test(text);
}

/**
 * An FLA's name as a person reads it. `occupationName`, where the caller has
 * the FLA's occupation in the person's language, names a recruited specialist.
 */
export function shownAgentName(name, language = DEFAULT_CONSOLE_LANGUAGE, { occupationName = null } = {}) {
  const text = String(name ?? '').trim();
  const words = WORDS[CONSOLE_LANGUAGES.includes(language) ? language : DEFAULT_CONSOLE_LANGUAGE];
  if (TEMPORARY_LEAD.test(text)) return words.temporaryLead;
  const numbered = NUMBERED_LEAD.exec(text);
  if (numbered) return words.numberedLead(numbered[1]);
  if (WORK_KIND_AGENT.test(text)) return occupationName ? words.occupation(occupationName) : words.specialist;
  return text;
}

/** An FLA record's shown name: the name the person gave it, else its role name in their words. */
export function agentDisplayName(agent, language = DEFAULT_CONSOLE_LANGUAGE, options) {
  const profile = agent?.profile ?? {};
  const given = String(profile.displayName ?? profile.display_name ?? '').trim();
  if (given && !isGeneratedAgentName(given)) return given;
  const name = shownAgentName(profile.name ?? given, language, options);
  return name || agent?.agentId || agent?.agent_id || '';
}
