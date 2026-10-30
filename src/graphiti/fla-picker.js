import { nativeChoiceInteraction } from '../conversations/human-interaction.js';
import { FIXED_EMPLOYEE_AGENT_TYPES, employeeAgentId, employeeCapability } from '../employees/manifest.js';
import { identityKey } from '../text/name-identity.js';
import { termIndex } from '../standing-assignments/term-match.js';
import { agentUnavailableReason } from './agent-availability.js';
import { ASSISTANT_AGENT_ID } from './assistant-identity.js';
import { isPeerRoleAgent } from './project-team-view.js';
import { projectDisplayName } from './task-entry-project-mention.js';

// The person's FLAs as choices (rec#54): one candidate per FLA and project it
// works in, so the same name in two projects is two choices. Matching a typed
// name, narrowing a partial one and ranking are shared by every picker over
// FLAs; rec#55's @FLG member choice reuses them with a multi-select
// presentation and names found anywhere in its text. Names, projects and
// role text only: nothing here reads memory, and the
// Provider still decides whether a chosen FLA may work.

// Claude Code's native choice UI shows at most four options; the numbered
// list other clients show stays the same four, so a number means one thing.
const PICKER_OPTIONS = 4;
const GLOBAL_PROJECT = '全局';
// Management peers, AR and the assistant are FULI's own roles, and temporary
// Agents belong to one task: none is an FLA a person continues by name.
const NOT_PICKABLE_TYPES = new Set(['hr', 'temporary']);
// A name ends at the end, a space or punctuation, or where the script changes
// (`Jamie Ash继续`). Two CJK runs never split: `@小林子` is not "小林".
const NAME_END = /^(?:$|[\s,，:：;；!?！？.。、(（])/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PARTIAL_LIMIT = 64;
const WORD_MINIMUM = 2;
const ASCII = /^[\x21-\x7e]+$/u;
const FUZZY = 2;

// Candidates from a roster read of the whole personal space and its
// nameable projects (nameableProjects). projectId null is an FLA without a
// project (its global scope); undefined is one whose projects all ended.
export function flaCandidates(roster, projects, personalSpaceId) {
  const named = new Map(projects.map(project => [project.project_id, project]));
  return inSpace(roster, personalSpaceId).filter(agent => agent.agent_id !== ASSISTANT_AGENT_ID
    && !NOT_PICKABLE_TYPES.has(agent.profile?.agent_type)
    && !isPeerRoleAgent({ agentId: agent.agent_id, agentType: agent.profile?.agent_type,
      capabilities: agent.profile?.capabilities ?? [] }))
    .flatMap(agent => placements(agent, named).map(placement => candidate(agent, placement)));
}

// FULI's own roles (rec#58): Jefa, Bole and Tonborg work in the folder's
// project (projectId undefined outside one), Astro globally. They are named
// only exactly, with `#FLA <name>`, never listed in the picker; the Provider
// and the role's own project scope still decide whether one may work there.
export function roleCandidates(roster, projects, personalSpaceId, currentProjectId) {
  const current = projects.find(project => project.project_id === currentProjectId);
  return inSpace(roster, personalSpaceId).filter(isFixedRole).map(agent => ({ ...candidate(agent,
    { project: agent.agent_id === ASSISTANT_AGENT_ID ? null : current, assignment: null }), role: true }));
}

function inSpace(roster, personalSpaceId) {
  return roster.filter(agent => !agent.personal_space_id || agent.personal_space_id === personalSpaceId);
}

// The Provider's own identity of a fixed role, not an Agent reusing its id.
function isFixedRole(agent) {
  return Object.keys(FIXED_EMPLOYEE_AGENT_TYPES).some(id => agent.agent_id === employeeAgentId(id)
    && (agent.profile?.capabilities ?? []).includes(employeeCapability(id)));
}

function placements(agent, named) {
  const assignments = agent.assignments ?? [];
  const active = assignments.filter(item => item.status === 'active' && named.has(item.personal_project_id));
  if (active.length) return active.map(item => ({ project: named.get(item.personal_project_id), assignment: item }));
  const unplaced = !assignments.length && !agent.personal_project_id;
  return [{ project: unplaced ? null : undefined, assignment: null }];
}

function candidate(agent, { project, assignment }) {
  const profile = agent.profile ?? {};
  const name = profile.display_name || profile.name || agent.agent_id;
  return { agentId: agent.agent_id, projectId: project === undefined ? undefined : project?.project_id ?? null,
    name, project: project ? projectDisplayName(project) : project === null ? GLOBAL_PROJECT : null,
    occupation: profile.display_name && profile.name !== name ? profile.name : '',
    responsibility: profile.responsibility ?? '', capabilities: profile.capabilities ?? [],
    status: profile.status ?? 'active', allowedClients: profile.allowed_clients ?? [],
    recency: Math.max(0, ...[assignment?.updated_at, agent.current_task_running_since, agent.updated_at]
      .map(value => Date.parse(value ?? '')).filter(Number.isFinite)) };
}

// Whether this client may continue the candidate now, or why not.
export function unavailableReason(candidate, sourceApplication) {
  const placement = candidate.role ? 'needs_project' : 'no_project';
  return agentUnavailableReason(candidate, sourceApplication) ?? (candidate.projectId === undefined ? placement : null);
}

// This session's own FLA first, then the current project's FLAs, then the
// roster's latest activity, then by name.
export function rankCandidates(candidates, { currentProjectId = null, recentAgentId = null } = {}) {
  return [...candidates].sort((a, b) => (b.agentId === recentAgentId) - (a.agentId === recentAgentId)
    || (b.projectId === currentProjectId) - (a.projectId === currentProjectId)
    || b.recency - a.recency
    || a.name.localeCompare(b.name));
}

// The candidates whose whole name opens the query, longest name first:
// `@Jamie Ash 继续` names "Jamie Ash" even when "Jamie" exists too.
export function namedAtOpening(query, candidates) {
  const text = identityKey(query);
  const matches = candidates.map(item => ({ item, key: identityKey(item.name) }))
    .filter(({ key }) => key && text.startsWith(key) && nameEnds(key, text.slice(key.length)));
  const longest = Math.max(0, ...matches.map(({ key }) => key.length));
  return matches.filter(({ key }) => key.length === longest).map(({ item }) => item);
}

// The candidates one of whose name's words is exactly the query's first word
// (`@Jamie` for "Jamie Ash"; rec#11 D-68a). The word has at least two
// characters, and a Latin one is matched as written: `@test` is an ordinary
// prompt even beside "Test Bot". A word that is also a common term, written
// as the name writes it (`@Mock` for "Mock Li"), still matches.
export function namedByWord(query, candidates) {
  const word = typedWord(query);
  if ([...word].length < WORD_MINIMUM) return [];
  const words = name => ASCII.test(word) ? name.normalize('NFKC').split(/\s+/u) : identityKey(name).split(' ');
  const key = ASCII.test(word) ? word : identityKey(word);
  return candidates.filter(item => words(item.name).includes(key));
}

// The candidates a partial name (the query's first word) fits, closest fit
// first: names that start with it, or have a word that does (close fits);
// only when there is none, names whose letters it follows in order (`@jsh`
// fits "Jamie Ash"), which only narrow a picker. Ranking order within a fit.
export function narrowedByPartial(query, candidates) {
  const partial = identityKey(typedWord(query));
  const fits = partial ? candidates.map(item => ({ item, fit: partialFit(partial, identityKey(item.name)) }))
    .filter(({ fit }) => fit !== null) : [];
  const close = fits.some(({ fit }) => fit < FUZZY);
  return { close, items: fits.filter(({ fit }) => fit < FUZZY || !close).sort((a, b) => a.fit - b.fit)
    .map(({ item }) => item) };
}

function partialFit(partial, name) {
  if (name.startsWith(partial)) return 0;
  if (name.split(' ').some(word => word.startsWith(partial))) return 1;
  if ([...partial].length < 2) return null;
  let at = 0;
  for (const character of name) if (at < partial.length && partial.startsWith(character, at)) at += character.length;
  return at === partial.length ? FUZZY : null;
}

// The query's first word as typed (compatibility forms folded, case kept),
// cut where punctuation or the script changes, at most PARTIAL_LIMIT long.
export function typedWord(query) {
  const characters = [...String(query).normalize('NFKC').trimStart().split(/\s/u)[0]];
  const end = characters.findIndex((character, index) => index > 0
    && (NAME_END.test(character) || CJK.test(character) !== CJK.test(characters[index - 1])));
  return characters.slice(0, end < 0 ? PARTIAL_LIMIT : Math.min(end, PARTIAL_LIMIT)).join('');
}

function nameEnds(name, rest) {
  if (NAME_END.test(rest)) return true;
  return CJK.test([...name].at(-1)) !== CJK.test([...rest][0]);
}

// The names a free text carries anywhere, as whole terms (term-match.js), each
// with every candidate of that name: longest names first, and a name inside a
// longer one already found does not count again ("Jamie" in "Jamie Ash"). A
// word written `@Jamie` names whoever namedByWord finds. Order of appearance.
export function namedInText(text, candidates) {
  let rest = identityKey(text);
  const found = [];
  const keys = [...new Set(candidates.map(item => identityKey(item.name)).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const at = termIndex(rest, key);
    if (at === -1) continue;
    found.push({ at, items: candidates.filter(item => identityKey(item.name) === key) });
    rest = rest.slice(0, at) + '\u0000'.repeat(key.length) + rest.slice(at + key.length);
  }
  for (const word of String(text).matchAll(/(?:^|\s)@(\S+)/gu)) {
    const items = namedByWord(word[1], candidates).filter(item => !found.some(({ items: known }) => known.includes(item)));
    if (items.length) found.push({ at: Infinity, items });
  }
  return found.sort((a, b) => a.at - b.at).map(({ items }) => items);
}

// The native single choice over the first PICKER_OPTIONS candidates, each
// "n. name — project — occupation"; the question says how many more a longer
// name would reach. No internal ID is shown. guidance: what a pick leads to.
export function flaChoice(candidates, { title, question, guidance }) {
  const shown = candidates.slice(0, PICKER_OPTIONS);
  const more = candidates.length - shown.length;
  return { shown, more, interaction: nativeChoiceInteraction({ source: { kind: 'fla_picker' }, title, guidance,
    question: `${question}（姓名 — 项目 — 职业）${more ? `还有 ${more} 位，输入更多名字可缩小范围。` : ''}`,
    options: shown.map(optionText) }) };
}

// The native multi-select over at most PICKER_OPTIONS members (rec#55), each
// "n. name — project — occupation · note" where note says why it is offered;
// the preselected ones are those marked so. Same numbering in every client.
export function flaGroupChoice(members, { title, question, guidance }) {
  const shown = members.slice(0, PICKER_OPTIONS);
  return { shown, interaction: nativeChoiceInteraction({ source: { kind: 'flg_picker' }, title, guidance,
    question: `${question}（姓名 — 项目 — 职业 · 理由）`, selection: 'multiple',
    preselected: shown.flatMap((item, index) => item.preselected ? [index + 1] : []),
    options: shown.map((item, index) => `${optionText(item, index)}${item.note ? ` · ${item.note}` : ''}`) }) };
}

function optionText(item, index) {
  return `${index + 1}. ${[item.name, item.project, item.occupation].filter(Boolean).join(' — ')}`;
}
