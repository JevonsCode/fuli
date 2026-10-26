import { coversClient } from '../agents/source-applications.js';
import { nativeChoiceInteraction } from '../conversations/human-interaction.js';
import { identityKey } from '../text/name-identity.js';
import { isPeerRoleAgent } from './project-team-view.js';
import { projectDisplayName } from './task-entry-project-mention.js';
import { ASSISTANT_AGENT_ID } from './task-entry-project-scope.js';

// The person's FLAs as choices (rec#54): one candidate per FLA and project it
// works in, so the same name in two projects is two choices. Matching a typed
// name, narrowing a partial one and ranking are shared by every picker over
// FLAs; rec#55's @FLG member choice reuses them with a multi-select
// presentation. Names and projects only: nothing here reads memory, and the
// Provider still decides whether a chosen FLA may work.

// Claude Code's native choice UI shows at most four options; the numbered
// list other clients show stays the same four, so a number means one thing.
const PICKER_OPTIONS = 4;
const GLOBAL_PROJECT = '全局';
// Management peers, AR and the assistant are FULI's own roles, and temporary
// Agents belong to one task: none is an FLA a person continues by name.
const NOT_PICKABLE_TYPES = new Set(['hr', 'temporary']);
// After a name: the end, a space or punctuation. A name ending in a CJK
// character may run straight into the request (`@小林继续`).
const NAME_END = /^(?:$|[\s,，:：;；!?！？.。、(（])/u;
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const PARTIAL_LIMIT = 64;
const FUZZY = 2;

// Candidates from a roster read of the whole personal space and its
// nameable projects (nameableProjects). projectId null is an FLA without a
// project (its global scope); undefined is one whose projects all ended.
export function flaCandidates(roster, projects, personalSpaceId) {
  const named = new Map(projects.map(project => [project.project_id, project]));
  return roster.filter(agent => (!agent.personal_space_id || agent.personal_space_id === personalSpaceId)
    && agent.agent_id !== ASSISTANT_AGENT_ID && !NOT_PICKABLE_TYPES.has(agent.profile?.agent_type)
    && !isPeerRoleAgent({ agentId: agent.agent_id, agentType: agent.profile?.agent_type,
      capabilities: agent.profile?.capabilities ?? [] }))
    .flatMap(agent => placements(agent, named).map(placement => candidate(agent, placement)));
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
    status: profile.status ?? 'active', clients: profile.allowed_clients ?? [],
    recency: Math.max(0, ...[assignment?.updated_at, agent.current_task_running_since, agent.updated_at]
      .map(value => Date.parse(value ?? '')).filter(Number.isFinite)) };
}

// Whether this client may continue the candidate now, or why not.
export function unavailableReason(candidate, sourceApplication) {
  if (candidate.status === 'archived') return 'dismissed';
  if (candidate.status !== 'active') return 'inactive';
  if (candidate.projectId === undefined) return 'no_project';
  return coversClient(candidate.clients, sourceApplication) ? null : 'client_not_allowed';
}

// Most recently used first (this session's own FLA, then the roster's latest
// activity), then the current project's, then by name.
export function rankCandidates(candidates, { currentProjectId = null, recentAgentId = null } = {}) {
  return [...candidates].sort((a, b) => (b.agentId === recentAgentId) - (a.agentId === recentAgentId)
    || b.recency - a.recency
    || (b.projectId === currentProjectId) - (a.projectId === currentProjectId)
    || a.name.localeCompare(b.name));
}

// The candidates whose whole name opens the query, longest name first:
// `@Jamie Ash 继续` names "Jamie Ash" even when "Jamie" exists too.
export function namedAtOpening(query, candidates) {
  const text = identityKey(query);
  const matches = candidates.map(item => ({ item, key: identityKey(item.name) }))
    .filter(({ key }) => key && text.startsWith(key)
      && (NAME_END.test(text.slice(key.length)) || CJK_END.test(key)));
  const longest = Math.max(0, ...matches.map(({ key }) => key.length));
  return matches.filter(({ key }) => key.length === longest).map(({ item }) => item);
}

// The candidates a partial name (the query's first word) fits: names that
// start with it, or have a word that does; only when none does, names whose
// letters it follows in order (`@jsh` fits "Jamie Ash"). Closest fit first,
// in ranking order within a fit.
export function narrowedByPartial(query, candidates) {
  const partial = identityKey(query).split(' ')[0].slice(0, PARTIAL_LIMIT);
  if (!partial) return [];
  const fits = candidates.map(item => ({ item, fit: partialFit(partial, identityKey(item.name)) }))
    .filter(({ fit }) => fit !== null);
  const closest = Math.min(...fits.map(({ fit }) => fit), FUZZY);
  return fits.filter(({ fit }) => fit < FUZZY || closest === FUZZY).sort((a, b) => a.fit - b.fit)
    .map(({ item }) => item);
}

function partialFit(partial, name) {
  if (name.startsWith(partial)) return 0;
  if (name.split(' ').some(word => word.startsWith(partial))) return 1;
  if ([...partial].length < 2) return null;
  let at = 0;
  for (const character of name) if (at < partial.length && partial.startsWith(character, at)) at += character.length;
  return at === partial.length ? FUZZY : null;
}

// The native single choice over the first PICKER_OPTIONS candidates, each
// "n. name — project — occupation"; the question says how many more a longer
// name would reach. No internal ID is shown.
export function flaChoice(candidates, { title, question }) {
  const shown = candidates.slice(0, PICKER_OPTIONS);
  const more = candidates.length - shown.length;
  const options = shown.map((item, index) => `${index + 1}. ${[item.name, item.project, item.occupation]
    .filter(Boolean).join(' — ')}`);
  return { shown, more, interaction: nativeChoiceInteraction({ source: { kind: 'fla_picker' }, title,
    question: `${question}（姓名 — 项目 — 职业）${more ? `还有 ${more} 位，输入更多名字可缩小范围。` : ''}`, options }) };
}
