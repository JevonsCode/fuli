// How a person addresses one of their FLAs in a prompt (rec#54), or several
// (rec#55). Parsing only: which FLA a name means is decided against the
// person's roster (fla-picker.js), and whether it may work by the Provider.
//
// - `#FLA <name>` or `@FLA <name>`: the explicit form. `#FLA` also counts
//   later in the prompt as a whole word outside code; `@FLA` only at the start.
// - `@<name>` at the very start of the prompt. An `@` later in the prompt,
//   inside quotes or code, never addresses an FLA.
// - A bare `#FLA` / `@FLA` asks for the picker; `#FLA 2` answers it;
//   `@FLA 结束` (end, release) ends this session's binding.
// - `@FLG …` or `#FLG …` (Fuli Agents Group) only at the very start: a
//   discussion among several FLAs. Its text may name members and ask for
//   more to be recommended (task-entry-group-discussion.js); `@FLG 1 3` or
//   `@FLG 开始` answers its member choice and `@FLG 结束` stops it. A bare
//   reply of numbers answers the choice too; a bare "好" or "开始" does not.
//
// A leading `@` is not an address when it is evidently something else: an
// email (`@user@example.com`), a package scope or path (`@scope/pkg`), a code
// decorator or annotation (`@Override`, `@dataclass`, `@app.route(...)`), or a
// file name (`@README.md`).

const KEYWORD = /^[#@]FLA(?=$|\s)/iu;
const HASH_KEYWORD = /(?:^|\s)#FLA(?=$|\s)/iu;
const GROUP = /^[#@]FLG(?=$|[\s:：,，])/iu;
const RELEASE = /^(?:结束|释放|解除|退出|停止|end|release|stop)\s*[。.!！]?\s*$/iu;
const CHOICE = /^(\d{1,2})\s*[.、)）]?\s*$/u;
// Several numbers answer a multi-select (`1 3`, `1,3`, `1、3`), optionally
// followed by a confirmation word. A confirmation word alone takes the
// preselection only after `@FLG` (`@FLG 开始`).
const CHOICES = /^(\d{1,2}(?:\s*[,，、\s]\s*\d{1,2})*)\s*[,，。]?\s*(?:开始|确认|go|start|ok)?\s*[。.!！]?\s*$/iu;
const CONFIRM = /^(?:开始|开始吧|确认|go|start)\s*[。.!！]?\s*$/iu;
// Inline code and fenced blocks are quoted text, never an address.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/gu;
// An identifier called like a function (`@Component(`) or a dotted name
// (`@pytest.mark`, `@README.md`). A trailing dot alone (`@J.R.`) is a name.
const CALLED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/u;
const DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u;
// Annotations and decorators people paste most often, written exactly so.
const DECORATORS = new Set(['Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs',
  'Test', 'BeforeEach', 'AfterEach', 'BeforeAll', 'AfterAll', 'Autowired', 'Component', 'Service', 'Repository',
  'Controller', 'RestController', 'Bean', 'Configuration', 'Entity', 'Injectable', 'Input', 'Output', 'NgModule',
  'Nullable', 'NonNull', 'Transactional', 'dataclass', 'property', 'staticmethod', 'classmethod',
  'abstractmethod', 'override', 'cached_property']);
const ADDRESS_LIMIT = 2048;
const STABLE = /^\{([^{}\s]+)\}(?=$|[\s,，:：])/u;

// null, { release: true }, { choice: n }, { handoff: agentId } for the
// portable `@{agentId}` form (a hand-off's continuation prompt),
// { explicit, query }: the text after the keyword or `@`, which may name an
// FLA and continue with the task, or { group } for `@FLG …` (groupMention).
export function parseFlaMention(prompt) {
  const text = typeof prompt === 'string' ? prompt.trimStart() : '';
  const group = GROUP.exec(text);
  if (group) return { group: groupMention(text.slice(group[0].length)) };
  // `#FLA` later in the prompt counts outside code only; blanking keeps positions.
  const keyword = KEYWORD.exec(text) ?? HASH_KEYWORD.exec(text.replace(CODE, code => ' '.repeat(code.length)));
  if (keyword) {
    const rest = text.slice(keyword.index + keyword[0].length).trim().slice(0, ADDRESS_LIMIT);
    if (RELEASE.test(rest)) return { release: true };
    const choice = CHOICE.exec(rest);
    if (choice) return { choice: Number(choice[1]) };
    return { explicit: true, query: rest };
  }
  const address = leadingAgentAddress(text);
  if (address === null) return null;
  // `@{agentId}` is the portable form, resolved in its project's scope.
  const stable = stableAddress(address);
  if (stable) return stable.agentId ? { handoff: stable.agentId } : null;
  return address.startsWith('{') ? null : { explicit: false, query: address };
}

// What follows `@FLG`: { release } (stop the discussion), the answer to its
// member choice (numbers, or { confirm } for the preselection), or { query }:
// the question, which may name members and ask for recommendations.
function groupMention(rest) {
  const text = rest.replace(/^[\s:：,，]+/u, '').trim().slice(0, ADDRESS_LIMIT);
  if (RELEASE.test(text)) return { release: true };
  if (CONFIRM.test(text)) return { confirm: true };
  return groupChoiceReply(text) ?? { query: text };
}

// A reply of numbers to a member choice: { choices: [n…] } (distinct, as
// typed), or null for anything else.
export function groupChoiceReply(prompt) {
  const numbers = CHOICES.exec(typeof prompt === 'string' ? prompt.trim() : '');
  return numbers ? { choices: [...new Set(numbers[1].split(/[\s,，、]+/u).filter(Boolean).map(Number))] } : null;
}

// The portable `{agentId}` form (percent-encoded) an address opens with:
// null when it does not, { agentId: null } when it is malformed.
export function stableAddress(address) {
  const stable = STABLE.exec(address);
  if (!stable) return null;
  try { return { agentId: decodeURIComponent(stable[1]) }; } catch { return { agentId: null }; }
}

// A reply that is only a number, which answers a picker the session showed.
export function choiceNumber(prompt) {
  const choice = CHOICE.exec(typeof prompt === 'string' ? prompt.trim() : '');
  return choice ? Number(choice[1]) : null;
}

// The text after a leading `@` that may address an Agent, or null.
export function leadingAgentAddress(prompt) {
  const text = typeof prompt === 'string' ? prompt.trimStart() : '';
  if (!text.startsWith('@') || KEYWORD.test(text) || GROUP.test(text)) return null;
  const token = /^@(\S*)/u.exec(text)[1];
  if (!token || /[@/]/u.test(token) || CALLED.test(token) || DOTTED.test(token) || DECORATORS.has(token)) return null;
  return text.slice(1, ADDRESS_LIMIT + 1);
}
