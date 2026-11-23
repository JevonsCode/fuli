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
// on…" describe when an action may happen ("只在用户确认后才推送到远端" is a
// rule about pushing, for every task), so they are not scopes (review of
// #1070).
const STATED_SCOPE = [
  /^(?:仅|只)适用于\s*([^，,。：:；;]{2,40})/u,
  /^仅限(?:于)?\s*([^，,。：:；;]{2,40})/u,
  /^Only\s+for\s+([^,.:;]{2,60})/iu,
  /^Appl(?:ies|y)\s+only\s+to\s+([^,.:;]{2,60})/iu,
  /^Only\s+applies\s+to\s+([^,.:;]{2,60})/iu
];

// What follows such a word when it names a time or a condition rather than
// what the rule applies to: 「仅限周五发布，其他时间不要发版」 is a rule about
// releasing, for every task, not one limited to "周五发布" (review of #1070).
// Where the words could be either, they are not a scope: a rule FULI wrongly
// ranks last costs more than a scope it leaves to the model.
const NOT_A_SCOPE = new RegExp('(?:会话|周[一二三四五六日天末]|星期|礼拜|工作日|节假日|上午|下午|中午|晚上|夜里|夜间|白天|凌晨'
  + '|早上|今天|明天|每天|每周|每月|\\d+\\s*[点时:：]|之前|之后|以前|以后|时候|期间|确认|同意|批准|允许|通过后|完成后'
  + '|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend|morning|afternoon|evening|night'
  + '|today|tomorrow|daily|weekly|before|after|until|unless|once|approv|confirm)', 'iu');

// The scope an instruction states in prose, or null. A session clause is
// already structured (preference-task-scope.js legacyPreferenceSession), so it
// is left to that reader rather than repeated here.
export function statedPreferenceScope(instruction) {
  if (typeof instruction !== 'string') return null;
  const text = instruction.trim();
  for (const pattern of STATED_SCOPE) {
    const scope = pattern.exec(text)?.[1]?.trim();
    if (scope && !NOT_A_SCOPE.test(scope)) return singleLineExcerpt(scope, SCOPE_CHARS);
  }
  return null;
}

// What one omitted preference is about, in one line: its key, its layer where
// that is not global (a key may exist at two layers), the opening of what it
// says, and the scope it states in prose where it states one. Never the whole
// body.
export function preferenceIndexLine(item) {
  const instruction = typeof item?.instruction === 'string' ? item.instruction : '';
  const scope = statedPreferenceScope(instruction);
  const layer = item?.preference_scope && item.preference_scope !== 'global' ? ` (${item.preference_scope})` : '';
  const gist = singleLineExcerpt(instruction, GIST_CHARS);
  const cut = gist.endsWith('…') && gist.length < instruction.length;
  // Any exception word the cut does not keep whole, including one it splits.
  const kept = GIST_CHARS - 1;
  const dropped = cut && [...instruction.matchAll(EXCEPTION)].some(match => match.index + match[0].length > kept);
  return `${item?.preference_key ?? ''}${layer}${SEPARATOR}${gist}${dropped ? EXCEPTION_MARK : ''}`
    + (scope ? `${SCOPE_MARK}${scope}` : '');
}

// The key an index entry names: a keys-tier entry is the key itself, a line
// starts with it, then its layer where that is not global.
export function preferenceIndexKey(entry) {
  return String(entry).split(SEPARATOR)[0].replace(/ \((?:agent|project)\)$/, '');
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

// At least half of the scope's distinctive units appear: Latin words of
// three letters or more, and pairs of adjacent Chinese characters, so
// "合成结算需求" meets "结算需求" without demanding the whole run. Half, not
// more: where FULI is unsure it gives the rule rather than withholds it.
function scopeMatches(scope, haystack) {
  const units = scopeUnits(scope);
  if (!units.length) return true;
  return units.filter(unit => haystack.includes(unit)).length * 2 >= units.length;
}

const FILLER = new Set(['the', 'this', 'that', 'and', 'for', 'with', 'work', 'task', 'tasks', 'when',
  '需求', '任务', '工作', '项目']);
function scopeUnits(scope) {
  const units = [];
  for (const [run] of scope.toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z][a-z0-9_-]{2,}/gu)) {
    if (/^\p{Script=Han}/u.test(run)) {
      if (run.length === 1) continue;
      for (let index = 0; index < run.length - 1; index++) units.push(run.slice(index, index + 2));
    } else units.push(run);
  }
  return units.filter(unit => !FILLER.has(unit));
}
