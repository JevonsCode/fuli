import path from 'node:path';

import { agentDisplayName } from '../agents/agent-label.js';
import { receiptText } from '../agents/identity-receipt.js';
import { workingRepository } from '../conversations/working-branch.js';
import { BRANCH_PREFIX } from '../standing-assignments/term-rules.js';
import { identityKey } from '../text/name-identity.js';
import { addressedAgentId } from './fla-mention.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';

// Which line of work of its own project a task belongs to (docs/workstreams.md).
// Only lines of the project the task is already in apply, by the request's
// words, a folder below the repository root of the working directory, or the
// current Git branch; words outrank folder and branch. With none, a session
// whose last task a line took goes on with it. The lead hands a task to a line
// by name (begin_task_context `workstream`). One match makes the line's owner
// this turn's FLA (project-agent-task-entry.js); several ask the person; none
// leaves the task with the lead. A standing assignment of the project that
// points at its lead is the person's rule for the lead, never a line: when its
// words match, the lead works this turn and no line goes on. No model; the
// lead is read from the Provider only when the request or a match names an
// assignment of the project.
//
// A task a line took keeps it in its Agent assignment's match basis,
// "workstream:<assignmentId>[ <notice>]", read back by prefix and ID alone;
// the notice, when the entry said one, is repeated by the checkpoint receipt.
//
// The repository ({ branch, root }) is read once, here, for a project with
// lines, and handed to the task's beginning (WORKING_REPOSITORY), which reads
// it for the conversation's place and its continuation line
// (task-context-entry.js); nothing reads it twice.

// The working repository this entry read, carried to the task's beginning without reaching any client.
export const WORKING_REPOSITORY = Symbol('working_repository');

const WORKSTREAM = /^workstream:(\S+)(?: (.+))?$/su;
// An explicit Agent says who; naming the project only says where, so its lines still apply.
const EXPLICIT_AGENT_BASES = new Set(['explicit_agent', 'explicit_fla']);
// Why a line took this turn, said in the notice; the first that applies.
const BECAUSE = Object.freeze({
  handoff: () => ({ 'zh-CN': '组长交给它', 'en-US': 'the lead handed it over' }),
  words: terms => ({ 'zh-CN': `因为提到「${terms.join('」「')}」`,
    'en-US': `the request mentions ${terms.map(term => `"${term}"`).join(', ')}` }),
  folder: terms => ({ 'zh-CN': `因为在目录 ${terms.join('/')} 下`, 'en-US': `the working folder is ${terms.join('/')}` }),
  branch: terms => {
    const names = terms.map(term => term.slice(BRANCH_PREFIX.length)).join('、');
    return { 'zh-CN': `因为在分支 ${names} 上`, 'en-US': `the branch is ${names}` };
  },
  session: () => ({ 'zh-CN': '延续本会话上一轮', 'en-US': 'the session\'s last task was on this line' })
});

// sessionTask: the session's last task, or null when the person's own #FLA
// bound it (task-entry-named-fla.js): a named FLA's turns never carry a line on.
export async function withWorkstream(application, resolution, input, sessionTask) {
  const projectId = resolution.status === 'matched' ? resolution.personalProjectId : null;
  if (!projectId || !application.standingAssignments || resolution.standingOwner || resolution.standingCandidates
    || resolution.fla || resolution.group) return resolution;
  const space = application.config.personal.spaceId;
  let lines;
  try {
    lines = application.standingAssignments.list(space).filter(line => line.projectId === projectId);
  } catch {
    return resolution;
  }
  // A project without lines reads nothing more: its entry is what it was.
  if (!lines.length) return resolution;
  const repository = await workingRepository(input.projectPath);
  const carried = { ...resolution, workingRepository: repository };
  if (input.projectAgentId || addressedAgentId(input.taskPrompt) !== null || EXPLICIT_AGENT_BASES.has(resolution.basis)
    || hostInternalActivity(application, input)) return carried;
  const requested = typeof input.workstream === 'string' && input.workstream.trim()
    ? lines.find(line => line.assignmentId === input.workstream.trim()
      || identityKey(line.responsibility) === identityKey(input.workstream)) ?? null : null;
  const matches = input.workstream ? [] : lineMatches(application, space, projectId, input, repository);
  const lastId = sessionTask?.personalProjectId === projectId ? taskWorkstreamId(sessionTask) : null;
  if (!requested && !matches.length && !lastId) {
    return input.workstream ? { ...carried, workstreamNotFound: input.workstream } : carried;
  }
  // Only a request or a match can name the person's rule for the lead; a
  // session going on with its line needs no read (a line moved to the lead is
  // then simply the lead's turn, project-agent-task-entry.js).
  const lead = requested || matches.length ? await projectLeadOf(application, space, projectId) : undefined;
  const isLine = assignment => assignment.leadAgentId !== lead;
  const line = (assignment, matchedOn, matchedTerms = [], termsOn = {}) => ({ ...carried,
    standingWorkstream: ownerOf(assignment, { matchedOn, matchedTerms, termsOn, lead, sessionTask }) });
  if (input.workstream) {
    return requested && isLine(requested) ? line(requested, ['handoff'])
      : { ...carried, workstreamNotFound: input.workstream };
  }
  const lineHits = matches.filter(({ assignment }) => isLine(assignment));
  const leadHits = matches.filter(({ assignment }) => !isLine(assignment));
  const said = hits => hits.filter(({ matchedOn }) => matchedOn.includes('words'));
  // A line its words name outranks the folder or branch of another; the
  // person's rule for the lead named in words outranks a line's folder or branch.
  const chosen = said(lineHits).length ? said(lineHits) : said(leadHits).length ? [] : lineHits;
  if (chosen.length > 1) return { ...carried, standingCandidates: chosen.map(hit => ownerOf(hit.assignment, { ...hit, lead })) };
  if (chosen.length === 1) {
    const [hit] = chosen;
    return line(hit.assignment, hit.matchedOn, hit.matchedTerms, hit.termsOn);
  }
  if (leadHits.length) return carried;
  const continued = lastId ? lines.find(item => item.assignmentId === lastId && isLine(item))
    ?? mergedInto(application, lastId, lines.filter(isLine)) : null;
  return continued ? line(continued, ['session']) : carried;
}

function lineMatches(application, space, projectId, input, repository) {
  const prompt = typeof input.taskPrompt === 'string' && input.taskPrompt.trim() ? input.taskPrompt : ' ';
  try {
    return application.standingAssignments.match(space, prompt, {
      folders: foldersBelowRoot(input.projectPath, repository?.root), branch: repository?.branch ?? null })
      .filter(({ assignment }) => assignment.projectId === projectId);
  } catch {
    return [];
  }
}

/** Whether this project has a line: an assignment of it whose Agent is not its lead. */
export async function projectHasLines(application, projectId) {
  const space = application.config.personal.spaceId;
  let assigned = [];
  try {
    assigned = application.standingAssignments?.list(space).filter(line => line.projectId === projectId) ?? [];
  } catch {
    return false;
  }
  if (!assigned.length) return false;
  const lead = await projectLeadOf(application, space, projectId);
  return assigned.some(line => line.leadAgentId !== lead);
}

// The project's lead, or undefined when it cannot be read: every assignment
// of the project then counts as a line, as an older FULI read them.
async function projectLeadOf(application, space, projectId) {
  try {
    return (await application.personal.getProjectAgentCoordinationPolicy(space, projectId))?.team_lead_agent_id
      ?? undefined;
  } catch {
    return undefined;
  }
}

// The line a merged one went into: a merge ends the line and moves all its
// terms into the target, so the active line holding every one of them.
function mergedInto(application, assignmentId, lines) {
  let ended = null;
  try { ended = application.standingAssignments.get(assignmentId); } catch { return null; }
  const keys = (ended?.retiredAt ? ended.terms : []).map(identityKey);
  if (!keys.length) return null;
  return lines.find(line => keys.every(key => line.terms.some(term => identityKey(term) === key))) ?? null;
}

// The folders of the working directory below its repository root, nearest
// last: never the user's home, the repository's own name or anything above.
// Outside a repository, or for a path this host cannot read as absolute
// (another system's), no folder counts.
function foldersBelowRoot(projectPath, root) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || !root) return [];
  const below = path.relative(root, path.resolve(projectPath));
  if (!below || below.startsWith('..') || path.isAbsolute(below)) return [];
  return below.split(/[\\/]+/u).filter(Boolean);
}

// continuing: the session's last task was this line's, by this owner.
function ownerOf(assignment, { matchedOn = [], matchedTerms = [], termsOn = {}, lead, sessionTask = null }) {
  return { assignmentId: assignment.assignmentId, projectId: assignment.projectId, leadAgentId: assignment.leadAgentId,
    workstream: assignment.responsibility, matchedTerms, matchedOn, termsOn, projectLeadId: lead ?? null,
    continuing: taskWorkstreamId(sessionTask) === assignment.assignmentId
      && sessionTask?.projectAgentId === assignment.leadAgentId };
}

/**
 * Whose records hold this session's work before a line's owner took it over:
 * the session's last owner when it was someone else in this project, or null.
 */
export function workstreamPredecessor(resolution, selection) {
  const owner = resolution.standingWorkstream;
  const from = resolution.sessionOwner;
  if (!owner || !from || !selection?.standingAgentApplied || from.agentId === owner.leadAgentId
    || from.personalProjectId !== owner.projectId) return null;
  return from;
}

/**
 * What the entry says and stores about the line this task belongs to. A turn
 * of the line its session was already on, by the same owner, says nothing and
 * only keeps its marker; any other says who works on it this turn, why, and
 * where the session's earlier progress is. predecessorName: the display name
 * of workstreamPredecessor, when it was read.
 */
export function workstreamEntry(resolution, selection, predecessorName = null) {
  const owner = resolution.standingWorkstream;
  // Nothing when the ordinary selection already chose its owner (one the lead read could not tell apart).
  const works = Boolean(selection?.standingAgentApplied);
  const unreached = Boolean(selection?.standingAgentUnreached);
  if (!works && !unreached) return null;
  if (works && owner.continuing) return { markers: [`workstream:${owner.assignmentId}`] };
  const line = `工作线「${owner.workstream}」`;
  const because = reasonOf(owner);
  const why = `（${because['zh-CN']}）`;
  const ownerName = selection.standingOwnerName ?? owner.leadAgentId;
  const selected = agentDisplayName(selection.agent) ?? '组长';
  const notice = works ? `${line}由 ${ownerName} 接手${why}${earlierProgress(resolution, selection, predecessorName)}`
    : selection.standingUnreachedReason === 'workstream_owner_not_on_project'
      ? `${line}${why}的负责人 ${ownerName} 已不在本项目，这次由 ${selected} 处理；可在项目页把这条线交给别人`
      : selection.standingUnreachedReason === 'client_not_allowed'
        ? `${line}${why}的负责人 ${ownerName} 不能在当前客户端工作，这次由 ${selected} 处理`
        : `${line}${why}的负责人 ${ownerName} 这次没能接上，由 ${selected} 处理`;
  return { notice, receiptNotice: receiptText(notice), markers: [`workstream:${owner.assignmentId} ${notice}`],
    field: { status: 'workstream', assignment_id: owner.assignmentId, workstream: owner.workstream,
      owner_agent_id: owner.leadAgentId, owner_name: ownerName, matched_terms: owner.matchedTerms,
      matched_on: owner.matchedOn ?? [], reason_text: because['en-US'],
      ...(unreached ? { owner_resolved: false, reason: selection.standingUnreachedReason ?? 'unavailable' } : {}),
      notice } };
}

function reasonOf(owner) {
  const on = owner.matchedOn ?? [];
  const kind = ['handoff', 'words', 'folder', 'branch'].find(item => on.includes(item)) ?? 'session';
  return BECAUSE[kind](owner.termsOn?.[kind] ?? owner.matchedTerms ?? []);
}

// "Where the session's earlier progress is": the lead's or a former owner's
// records, which the new owner does not hold. Nothing for a fresh session.
function earlierProgress(resolution, selection, predecessorName) {
  const from = workstreamPredecessor(resolution, selection);
  if (!from) return '';
  return from.agentId === resolution.standingWorkstream.projectLeadId ? '；本会话之前的进展在组长的记录里'
    : `；本会话之前的进展在 ${predecessorName ?? from.agentId} 的记录里`;
}

/** The notice a stored marker repeats in the checkpoint receipt, or null. */
export const workstreamNoticeOf = item => WORKSTREAM.exec(item)?.[2] ?? null;

/** The marker of a turn a named FLA worked as the owner of a line of its project. */
export function namedWorkstreamMarkers(selection) {
  return selection?.namedWorkstreamId ? [`workstream:${selection.namedWorkstreamId}`] : [];
}

function taskWorkstreamId(task) {
  return (task?.agentAssignment?.match_basis ?? []).map(item => WORKSTREAM.exec(item)?.[1]).find(Boolean) ?? null;
}
