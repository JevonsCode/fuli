// One short line for every preference a task entry cannot spell out (rec#137).
// An entry bounded to a host's inline limit used to name what it left out by
// count alone, so the only way to learn what existed was to page a whole
// revision at the MCP budget. The index names each omitted item by key, with
// its scope layer where it is not global and the opening of what it says, and
// read_task_preferences reads the ones that may apply by key.
//
// Where an instruction states the scope it applies to in prose only ("仅适用于
// X", "Only for X"), FULI lifts that phrase into the line as "· 仅适用于 X"
// (rec#111): a restriction written in a sentence is otherwise invisible to
// every filter, and an Agent has applied such a rule to an unrelated task. It
// is a marker and a ranking, never a removal: a misread clause must not
// silently drop a rule the person set.
import { singleLineExcerpt } from '../text/single-line.js';

// Long enough for one clause, short enough that a whole set of them costs less
// than a handful of bodies. Each line is one string, not an object: repeating
// JSON key names per item would cost more than the words do.
const GIST_CHARS = 36;
const SCOPE_CHARS = 24;
const SEPARATOR = ' — ';
const SCOPE_MARK = ' · 仅适用于 ';
// A cut that drops an exception would turn the rule into its opposite
// ("Never squash merge, except on relea…"), so such a line says so.
const EXCEPTION = /(?:除非|除了|例外|但是?|不过|except|unless|but\b|other than)/giu;
const EXCEPTION_MARK = ' (有例外，读全文 / has exceptions, read in full)';

// Only words that say what a rule applies to. "只在…" / "Only when…" / "Only
// on…" alone describe when an action may happen ("只在用户确认后才推送到远端" is
// a rule about pushing, for every task), so they are not scopes (review of
// #1070); one that says it is the rule that applies then ("仅在…时适用",
// "Applies only when…") is. `explicit`: the opening says the rule *applies*
// only there. 「仅限…」 / "Only for…" do not: 「仅限内部使用，不要外发截图」 limits
// what is done, for every task, so a hard rule is never left out on them
// (review of #1104), and they are read only as a marker on an index line.
// `head` ends where the case begins; `whole` matches a case that ends in its
// own words (「仅在 X 时适用」).
const STATED_SCOPE = [
  { head: /^(?:仅|只)适用于\s*/u, explicit: true },
  { whole: /^(?:仅|只|只有)(?:在|当)\s*([^。：:；;\n]{2,120}?)\s*(?:时|的时候)?才?适用/u, explicit: true },
  { head: /^Appl(?:ies|y)\s+only\s+to\s+/iu, explicit: true },
  { head: /^Only\s+applies\s+to\s+/iu, explicit: true },
  { head: /^(?:Appl(?:ies|y)\s+only|Only\s+applies)\s+(?:when|while|if)\s+/iu, explicit: true },
  { head: /^仅限(?:于)?\s*/u, explicit: false },
  { head: /^Only\s+for\s+/iu, explicit: false }
];
// The longest case read from an opening; a cut one would drop its later cases.
const CASE_CHARS = 120;
const OLD_CASE_CHARS = { han: 40, latin: 60 };

// What follows such a word when it names a time or a condition rather than
// what the rule applies to: 「仅限周五发布，其他时间不要发版」 is a rule about
// releasing, for every task, not one limited to "周五发布" (review of #1070).
// Where the words could be either, they are not a scope: a rule FULI wrongly
// ranks last costs more than a scope it leaves to the model.
const NOT_A_SCOPE = new RegExp('(?:会话|周[一二三四五六日天末]|星期|礼拜|工作日|节假日|上午|下午|中午|晚上|夜里|夜间|白天|凌晨'
  + '|早上|今天|明天|每天|每周|每月|\\d+\\s*[点时:：]|之前|之后|以前|以后|时候|期间|确认|同意|批准|允许|通过后|完成后'
  + '|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend|morning|afternoon|evening|night'
  + '|today|tomorrow|daily|weekly|before|after|until|unless|once|approv|confirm)', 'iu');
// After 仅限 / Only for: who may use or see something, a restriction on the
// action and never a case (「仅限内部使用」「仅限本人查看」「Only for internal use」).
const RESTRICTION = /^(?:内部|本人|自己|个人)|(?:使用|查看|阅读|访问|自用|内部)$|^(?:internal|personal|private)\b|\b(?:use|viewing|eyes)$/iu;

// The scope an instruction states in prose, in its own words, or null. A
// session clause is already structured (preference-task-scope.js
// legacyPreferenceSession), so it is left to that reader rather than repeated
// here. `explicitOnly`: only an opening that says the rule applies only there.
export function statedScopePhrase(instruction, options) {
  return statedScope(instruction, options)?.phrase ?? null;
}

// The same, with where the opening that states it ends in the instruction
// (`end`), so a reader can take what the rule says after it. A case that says
// it applies runs to a colon in the first sentence, so 「仅适用于 A，以及 B：…」
// keeps both; without a colon, to the first comma.
export function statedScope(instruction, { explicitOnly = false } = {}) {
  if (typeof instruction !== 'string') return null;
  const text = instruction.trim();
  for (const { head, whole, explicit } of STATED_SCOPE) {
    if (explicitOnly && !explicit) continue;
    const found = whole ? wholeCase(text, whole) : head.exec(text) && headCase(text, head.exec(text)[0].length, explicit);
    const phrase = found?.phrase.trim();
    if (!phrase || [...phrase].length < 2 || NOT_A_SCOPE.test(phrase) || (!explicit && RESTRICTION.test(phrase))) continue;
    return { phrase, end: found.end };
  }
  return null;
}

function wholeCase(text, pattern) {
  const match = pattern.exec(text);
  return match ? { phrase: match[1], end: match.index + match[0].length } : null;
}

function headCase(text, start, explicit) {
  const rest = text.slice(start);
  const sentence = rest.split(/[。；;\n]|\.(?:\s|$)/u)[0];
  const colon = explicit ? sentence.search(/[：:]/u) : -1;
  const stop = colon > 0 ? colon : sentence.search(/[，,：:]/u);
  const raw = stop >= 0 ? sentence.slice(0, stop) : sentence;
  const limit = explicit ? CASE_CHARS : /\p{Script=Han}/u.test(raw) ? OLD_CASE_CHARS.han : OLD_CASE_CHARS.latin;
  return { phrase: [...raw].slice(0, limit).join(''), end: start + raw.length };
}

// The same, cut to fit an index line.
export function statedPreferenceScope(instruction) {
  const scope = statedScopePhrase(instruction);
  return scope ? singleLineExcerpt(scope, SCOPE_CHARS) : null;
}

// What one omitted preference is about, in one line: its key, its layer where
// that is not global (a key may exist at two layers), the opening of what it
// says, and the scope it states in prose where it states one. Never the whole
// body.
export function preferenceIndexLine(item) {
  const instruction = typeof item?.instruction === 'string' ? item.instruction : '';
  const scope = statedPreferenceScope(instruction);
  const gist = singleLineExcerpt(instruction, GIST_CHARS);
  const cut = gist.endsWith('…') && gist.length < instruction.length;
  // Any exception word the cut does not keep whole, including one it splits.
  const kept = GIST_CHARS - 1;
  const dropped = cut && [...instruction.matchAll(EXCEPTION)].some(match => match.index + match[0].length > kept);
  return `${preferenceName(item)}${SEPARATOR}${gist}${dropped ? EXCEPTION_MARK : ''}`
    + (scope ? `${SCOPE_MARK}${scope}` : '');
}

// What a line calls one preference: its key, then its layer where that is
// not global (a key may exist at two layers).
export function preferenceName(item) {
  const layer = item?.preference_scope && item.preference_scope !== 'global' ? ` (${item.preference_scope})` : '';
  return `${item?.preference_key ?? ''}${layer}`;
}

// Whether an index entry names this preference: a line by its key and layer,
// a keys-tier entry by the key alone, which cannot tell two layers apart.
export function preferenceIndexNames(entry, item) {
  const text = String(entry);
  return indexEntryIsLine(text) ? text.split(SEPARATOR)[0] === preferenceName(item) : text === item?.preference_key;
}

// Whether a key is one FULI made from a habit's text (task-remember.js,
// task-experiences.js: the kind, a dash and 24 hex of a content hash), which
// names nothing a reader can use. A key a person or Agent chose never has
// that exact form in practice.
const GENERATED_KEY = /^(?:remember|experience)-[0-9a-f]{24}$/u;
export function generatedPreferenceKey(key) {
  return typeof key === 'string' && GENERATED_KEY.test(key);
}

// Whether an index entry is a line (key, layer and gist) rather than a key alone.
export function indexEntryIsLine(entry) {
  return String(entry).includes(SEPARATOR);
}

// The index of the items an entry does not list, in the order they were
// resolved, so two turns with the same set produce the same index. `detail`
// is 'full' (a line each) or 'keys' (the keys alone), the cheaper tier for an
// entry whose limit cannot hold the lines but can still say what exists.
export function preferenceIndex(preferences, selected, detail = 'full') {
  const omitted = preferences.filter((_, index) => !selected.has(index));
  return detail === 'keys' ? omitted.map(item => item?.preference_key ?? '') : omitted.map(preferenceIndexLine);
}

// Whether a prose-stated scope names this session's project. It is read
// against the project — its ID, its name, the folder the session works in —
// not each prompt: what a session is about does not change turn to turn, so
// the inline selection stays the same and the next turn can still be a delta.
// A scoped rule that does not meet it ranks after the unrestricted ones and
// is named in the index with its scope; the model reads it by key when the
// task turns out to touch it. Without a stated scope, or with nothing to
// compare against, it counts as met: FULI never pushes an item out on a guess.
export function statedScopeMeetsProject(item, projectWords = []) {
  const scope = statedPreferenceScope(item?.instruction);
  const haystack = projectWords.filter(word => typeof word === 'string' && word.trim()).join(' ').toLowerCase();
  if (!scope || !haystack) return true;
  return scopeMatches(scope, haystack);
}

// One of the scope's distinctive units appears: Latin words of three letters
// or more, and pairs of adjacent Chinese characters, so "合成结算需求" meets
// "结算需求" without demanding the whole run. One, not more: where FULI is
// unsure it gives the rule rather than withholds it (a stated case against a
// task is read the same way, preference-conditions.js).
function scopeMatches(scope, haystack) {
  const units = distinctiveUnits(scope);
  if (!units.length) return true;
  return units.some(unit => haystack.includes(unit));
}

// Filler: words that say nothing about a case. Latin ones are dropped as
// words; Chinese ones are taken out of the whole text before it is cut into
// pairs, so no pair spans two of them (「所有任务」 used to leave 「有任」, review
// of #1104).
const FILLER = new Set(['the', 'this', 'that', 'and', 'for', 'with', 'work', 'task', 'tasks', 'when', 'only', 'applies',
  'all', 'any', 'every', 'always', 'default']);
const HAN_FILLER = /需求|任务|工作|项目|所有|任何|当前|相关|时候|情况|场景|以及|或者|的/gu;
// The words that say a habit is limited, never what it is limited to.
const LIMITING = /仅|只有|只|适用于|适用|才/gu;
// The text with filler and limiting words taken out, lowercased: what the
// units below are cut from, and what a request's length is counted on.
export function withoutFiller(text) {
  return String(text).toLowerCase().replace(LIMITING, ' ').replace(HAN_FILLER, ' ');
}

// The distinctive units of a text: Latin words of three letters or more, and
// pairs of adjacent Chinese characters, without filler. The same units decide
// a stated scope against a project and a stated case against a task
// (preference-conditions.js).
export function distinctiveUnits(text) {
  const units = [];
  for (const [run] of withoutFiller(text).matchAll(/[\p{Script=Han}]+|[a-z][a-z0-9_-]{2,}/gu)) {
    if (/^\p{Script=Han}/u.test(run)) {
      if (run.length === 1) continue;
      for (let index = 0; index < run.length - 1; index++) units.push(run.slice(index, index + 2));
    } else if (!FILLER.has(run)) units.push(run);
  }
  return units;
}
