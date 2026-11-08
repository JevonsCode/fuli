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
//   in this session, `圆桌` in the roundtable), and `#FLG 结束` stops it. A
//   bare reply of numbers answers the choice too; a bare "好", "开始" or
//   "一起看" does not.

const KEYWORD = /^#FLA(?=$|\s)/iu;
const GROUP = /^#FLG(?=$|[\s:：,，])/iu;
const RELEASE = /^(?:结束|释放|解除|退出|停止|end|release|stop)\s*[。.!！]?\s*$/iu;
const CHOICE = /^(\d{1,2})\s*[.、)）]?\s*$/u;
// How a confirmed group works (rec#55): in this session, which reads every
// member's context (mode 1), or in the roundtable, where each member is woken
// and answers for itself (mode 2). The choice offers both labels.
const SESSION_MODE = String.raw`在?(?:这个|本)会话里?一起看|本会话|一起看|same session|this session`;
const ROUNDTABLE_MODE = String.raw`在?圆桌里?分头回复|圆桌|分头回复|roundtable`;
const MODE = String.raw`(?:(${SESSION_MODE})|(${ROUNDTABLE_MODE}))`;
// Several numbers answer a multi-select (`1 3`, `1,3`, `1、3`), optionally
// followed by a confirmation word and a mode. A confirmation word or a mode
// alone takes the preselection only after `#FLG` (`#FLG 开始`, `#FLG 一起看`).
const CHOICES = new RegExp(String.raw`^(\d{1,2}(?:\s*[,，、\s]\s*\d{1,2})*)\s*[,，。]?\s*(?:开始|确认|go|start|ok)?`
  + String.raw`\s*[,，]?\s*${MODE}?\s*[。.!！]?\s*$`, 'iu');
const CONFIRM = new RegExp(String.raw`^(开始吧|开始|确认|go|start)?\s*[,，]?\s*${MODE}?\s*[。.!！]?\s*$`, 'iu');
// Files a client attaches ahead of the person's words (Claude Code writes
// `@"C:\…\clip.mp4"`): a quoted path, or a token with a path separator or a
// file extension. They are skipped before deciding what the message starts with.
const ATTACHMENT = /^@(?:"[^"\n]*"|'[^'\n]*'|(\S+))(?:\s+|$)/u;
const FILE_LIKE = /[\\/]|[^.]\.(?=\d*[A-Za-z])[A-Za-z\d]{1,10}$/u;
const ADDRESS_LIMIT = 2048;
const STABLE = /^\{([^{}\s]+)\}(?=$|[\s,，:：])/u;
// Compatibility with prompts FULI 0.23 and earlier wrote (continuation
// prompts, roundtable wakes): `@{<uuid>}` at the start, a whole UUID only.
// Nothing writes it any more; drop it once 0.23 prompts are out of use.
const LEGACY_STABLE = /^@\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}(?=$|[\s,，:：])/iu;

// null, { release: true }, { choice: n }, { handoff: agentId } for the stable
// `#FLA {agentId}` form, { explicit: true, query }: the text after `#FLA`,
// which may name an FLA and continue with the task, or { group } for `#FLG …`
// (groupMention).
export function parseFlaMention(prompt) {
  const text = afterAttachments(typeof prompt === 'string' ? prompt.trimStart() : '');
  const group = GROUP.exec(text);
  if (group) return { group: groupMention(text.slice(group[0].length)) };
  const legacy = LEGACY_STABLE.exec(text);
  if (legacy) return { handoff: legacy[1] };
  const keyword = KEYWORD.exec(text);
  if (!keyword) return null;
  const rest = text.slice(keyword[0].length).trim().slice(0, ADDRESS_LIMIT);
  const stable = stableAddress(rest);
  if (stable) return stable.agentId ? { handoff: stable.agentId } : null;
  if (RELEASE.test(rest)) return { release: true };
  const choice = CHOICE.exec(rest);
  if (choice) return { choice: Number(choice[1]) };
  return { explicit: true, query: rest };
}

// The Agent a prompt addresses by its stable ID (`#FLA {agentId}`, or a
// legacy `@{uuid}`), or null.
export function addressedAgentId(prompt) {
  return parseFlaMention(prompt)?.handoff ?? null;
}

// The message without the files attached at its start.
function afterAttachments(text) {
  let rest = text;
  for (let file = ATTACHMENT.exec(rest); file && (file[1] === undefined || FILE_LIKE.test(file[1]));
    file = ATTACHMENT.exec(rest)) rest = rest.slice(file[0].length);
  return rest;
}

// What follows `#FLG`: { release } (stop the discussion), the answer to its
// member choice (numbers, or { confirm } for the preselection, each with the
// mode when it names one), or { query }: the question, which may name
// members and ask for recommendations.
function groupMention(rest) {
  const text = rest.replace(/^[\s:：,，]+/u, '').trim().slice(0, ADDRESS_LIMIT);
  if (RELEASE.test(text)) return { release: true };
  const confirm = CONFIRM.exec(text);
  if (confirm?.slice(1).some(Boolean)) return { confirm: true, ...namedMode(confirm) };
  return groupChoiceReply(text) ?? { query: text };
}

// A reply of numbers to a member choice: { choices: [n…] } (distinct, as
// typed) and the mode it names, or null for anything else.
export function groupChoiceReply(prompt) {
  const numbers = CHOICES.exec(typeof prompt === 'string' ? prompt.trim() : '');
  return numbers ? { choices: [...new Set(numbers[1].split(/[\s,，、]+/u).filter(Boolean).map(Number))],
    ...namedMode(numbers) } : null;
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

// A reply that is only a number, which answers a picker the session showed.
export function choiceNumber(prompt) {
  const choice = CHOICE.exec(typeof prompt === 'string' ? prompt.trim() : '');
  return choice ? Number(choice[1]) : null;
}
