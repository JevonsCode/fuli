// How a person addresses one of their FLAs in a prompt (rec#54), or several
// (rec#55). Parsing only: which FLA a name means is decided against the
// person's roster (fla-picker.js), and whether it may work by the Provider.
//
// Every FULI address starts with `#`. `@` belongs to the clients (Claude Code
// attaches files with `@"C:\…\clip.mp4"`, Cursor and Codex reference with it),
// so `@` never addresses an FLA: `@Name`, `@FLA` and `@FLG` are plain text.
//
// - `#FLA <name>` names one of the person's FLAs or one of FULI's own roles
//   (Bole, Jefa, Tonborg, Astro; rec#58), only at the very start of the
//   message, after any whitespace and any files the client attached first.
//   Case does not matter (`#fla`, `#Fla`). Anywhere else (mid-sentence, a
//   later line, quotes, code) `#FLA` is text, such as a remark about the syntax.
// - `#FLA {agentId}` (percent-encoded) is the stable form FULI writes into
//   continuation prompts and roundtable wakes (flaAddress).
// - A bare `#FLA` asks for the picker; `#FLA 2` answers it;
//   `#FLA 结束` (end, release) ends this session's binding.
// - `#FLG …` (Fuli Agents Group) only at the very start: a discussion among
//   several FLAs. Its text may name members and ask for more to be
//   recommended (task-entry-group-discussion.js); `#FLG 1 3` or `#FLG 开始`
//   answers its member choice, optionally with how the group works (`一起看`
//   in this session, `圆桌` in the roundtable) and the roundtable's options
//   (`短期`/`长期`, `3轮`/`不限轮数`; rec#129), and `#FLG 结束` stops it. A
//   bare reply of numbers answers the choice too; a bare "好", "开始" or
//   "一起看" does not. `#FLG 加入 <code>` (or `join`) joins a started
//   discussion from any connected client.

// The keywords, half- or full-width `#`, any case.
const KEYWORD = /^[#＃]FLA(?=$|\s)/iu;
const GROUP = /^[#＃]FLG(?=$|[\s:：,，])/iu;
// Everything below reads at most this much of a prompt, and every pattern
// matches in linear time: a pasted prompt never stalls the entry.
const ADDRESS_LIMIT = 2048;
// Short replies (a number, a release, a confirmation) are first reduced to
// words with single spaces (reply), so their patterns hold no adjacent
// optional runs to backtrack over. Longer text is never such a reply.
const REPLY_LIMIT = 128;
const SEPARATORS = /[\s,，、。!！]+/gu;
const RELEASE = /^(?:结束|释放|解除|退出|停止|end|release|stop)\.?$/iu;
const CHOICE = /^(\d{1,2})[.)）]?$/u;
// How a confirmed group works (rec#55): in this session, which reads every
// member's context (mode 1), or in the roundtable, where each member is woken
// and answers for itself (mode 2). The choice offers both labels.
const SESSION_MODE = String.raw`在?(?:这个|本)会话里?一起看|本会话|一起看|same session|this session`;
const ROUNDTABLE_MODE = String.raw`在?圆桌里?分头回复|圆桌|分头回复|roundtable`;
const MODE = String.raw`(?:(${SESSION_MODE})|(${ROUNDTABLE_MODE}))`;
// Several numbers answer a multi-select (`1 3`, `1,3`, `1、3`), optionally
// followed by a confirmation word and a mode. A confirmation word or a mode
// alone takes the preselection only after `#FLG` (`#FLG 开始`, `#FLG 一起看`).
const CHOICES = new RegExp(String.raw`^(\d{1,2}(?: \d{1,2})*)(?: ?(?:开始|确认|go|start|ok))?(?: ?${MODE})?\.?$`, 'iu');
const CONFIRM = new RegExp(String.raw`^(开始吧|开始|确认|go|start)?(?: ?${MODE})?\.?$`, 'iu');
// A roundtable's options ride on the same answer (rec#129), each a whole word:
// how long its join code lives and how many rounds its host may lead.
const LONG = /(?:^| )(?:长期调研群|长期|long)(?= |$)/iu;
const SHORT = /(?:^| )(?:短期|short)(?= |$)/iu;
const ROUNDS = /(?:^| )(?:(?:限定|最多) ?)?([1-9]) ?(?:轮|rounds?)(?= |$)/iu;
const NO_ROUND_LIMIT = /(?:^| )(?:不限轮数|不限|no limit|unlimited)(?= |$)/iu;
// `#FLG 加入 7K3M` (or `join`): this session joins a started discussion by its code.
const JOIN = /^(?:加入|join) ?([a-z0-9]{4,8})$/iu;
// What a client puts ahead of the person's words is skipped before deciding
// what the message starts with: a quoted file (Claude Code writes
// `@"C:\…\clip.mp4"`, possibly with `#FLA` right after it) or any other `@`
// token without spaces (`@Makefile`, `@src/a.ts`, Cursor's `@Codebase`). A
// leading `@{…}` is not skipped: it is a legacy address.
const ATTACHMENT = /^@(?:"[^"\n]*"\s*|'[^'\n]*'\s*|(?!\{)\S+(?:\s+|$))/u;
const STABLE = /^\{([^{}\s]+)\}(?=$|[\s,，:：])/u;
// Compatibility with prompts FULI 0.23 and earlier wrote (continuation
// prompts, roundtable wakes): `@{agentId}` at the start, for any Agent ID
// (`@{employee.jefa}`, `@{<uuid>}`). Nothing writes it any more; drop it once
// 0.23 prompts are out of use.
const LEGACY_STABLE = /^@(?=\{)/u;

// null, { release: true }, { choice: n }, { handoff: agentId } for the stable
// `#FLA {agentId}` form, { explicit: true, query }: the text after `#FLA`,
// which may name an FLA and continue with the task, or { group } for `#FLG …`
// (groupMention).
export function parseFlaMention(prompt) {
  const text = afterAttachments(prompt);
  const group = GROUP.exec(text);
  if (group) return { group: groupMention(text.slice(group[0].length)) };
  if (LEGACY_STABLE.test(text)) {
    const legacy = stableAddress(text.slice(1));
    return legacy?.agentId ? { handoff: legacy.agentId } : null;
  }
  const keyword = KEYWORD.exec(text);
  if (!keyword) return null;
  const rest = text.slice(keyword[0].length).trim();
  const stable = stableAddress(rest);
  if (stable) return stable.agentId ? { handoff: stable.agentId } : null;
  const words = reply(rest);
  if (words !== null && RELEASE.test(words)) return { release: true };
  const choice = words === null ? null : CHOICE.exec(words);
  if (choice) return { choice: Number(choice[1]) };
  return { explicit: true, query: rest };
}

// The Agent a prompt addresses by its stable ID (`#FLA {agentId}`, or a
// legacy `@{agentId}`), or null.
export function addressedAgentId(prompt) {
  return parseFlaMention(prompt)?.handoff ?? null;
}

// The prompt's first ADDRESS_LIMIT characters, without leading whitespace and
// without what the client put ahead of the person's words. A cut prompt ends
// in `…`, so what is left can never read as a short reply.
function afterAttachments(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  let rest = (text.length > ADDRESS_LIMIT ? `${text.slice(0, ADDRESS_LIMIT)}…` : text).trimStart();
  for (let file = ATTACHMENT.exec(rest); file; file = ATTACHMENT.exec(rest)) rest = rest.slice(file[0].length);
  return rest;
}

// A short reply as words separated by single spaces, or null when the text is
// too long to be one.
function reply(text) {
  const trimmed = text.trim();
  return trimmed.length > REPLY_LIMIT ? null : trimmed.replace(SEPARATORS, ' ').trim();
}

// What follows `#FLG`: { release } (stop the discussion), the answer to its
// member choice (numbers, or { confirm } for the preselection, each with the
// mode when it names one), or { query }: the question, which may name
// members and ask for recommendations.
function groupMention(rest) {
  const text = rest.replace(/^[\s:：,，]+/u, '').trim();
  const words = reply(text);
  if (words !== null && RELEASE.test(words)) return { release: true };
  const join = words === null ? null : JOIN.exec(words);
  if (join) return { join: join[1].toUpperCase() };
  const { rest: answer, options } = discussionOptions(words);
  const confirm = answer === null ? null : CONFIRM.exec(answer);
  if (confirm?.slice(1).some(Boolean)) return { confirm: true, ...namedMode(confirm), ...options };
  // Only options (`#FLG 长期 不限轮数`) confirm the preselection with them.
  if (answer === '' && Object.keys(options).length) return { confirm: true, ...options };
  return choicesIn(answer, options) ?? { query: text };
}

// A reply of numbers to a member choice, after anything the client attached:
// { choices: [n…] } (distinct, as typed), the mode and the options it names, or null.
export function groupChoiceReply(prompt) {
  const { rest, options } = discussionOptions(reply(afterAttachments(prompt)));
  return choicesIn(rest, options);
}

function choicesIn(words, options = {}) {
  const numbers = words === null ? null : CHOICES.exec(words);
  return numbers ? { choices: [...new Set(numbers[1].split(' ').map(Number))], ...namedMode(numbers), ...options } : null;
}

// The roundtable options a short reply names ({ lifetime: 'short' | 'long',
// roundLimit: n, 0 for no limit }) and the reply without them.
function discussionOptions(words) {
  if (words === null) return { rest: null, options: {} };
  let rest = words;
  const options = {};
  const take = (pattern, apply) => {
    const found = pattern.exec(rest);
    if (!found) return;
    apply(found);
    rest = `${rest.slice(0, found.index)} ${rest.slice(found.index + found[0].length)}`.replace(/ +/gu, ' ').trim();
  };
  take(LONG, () => { options.lifetime = 'long'; });
  take(SHORT, () => { options.lifetime ??= 'short'; });
  take(NO_ROUND_LIMIT, () => { options.roundLimit = 0; });
  take(ROUNDS, found => { options.roundLimit ??= Number(found[1]); });
  return { rest, options };
}

// The mode a question asks for, 'session' or 'roundtable', or null.
export function groupModeHint(text) {
  if (new RegExp(ROUNDTABLE_MODE, 'iu').test(text)) return 'roundtable';
  return new RegExp(SESSION_MODE, 'iu').test(text) ? 'session' : null;
}

// The mode a confirmation names: its last two groups are MODE's.
function namedMode(match) {
  const [session, roundtable] = match.slice(-2);
  return session ? { mode: 'session' } : roundtable ? { mode: 'roundtable' } : {};
}

// The `{agentId}` form (percent-encoded) an address opens with: null when it
// does not, { agentId: null } when it is malformed.
function stableAddress(address) {
  const stable = STABLE.exec(address);
  if (!stable) return null;
  try { return { agentId: decodeURIComponent(stable[1]) }; } catch { return { agentId: null }; }
}

// A reply that is only a number, which answers a picker the session showed;
// files the client attached ahead of it do not count.
export function choiceNumber(prompt) {
  const words = reply(afterAttachments(prompt));
  const choice = words === null ? null : CHOICE.exec(words);
  return choice ? Number(choice[1]) : null;
}
