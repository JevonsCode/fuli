import path from 'node:path';

import { receiptText } from '../agents/identity-receipt.js';
import { workingRepository } from '../conversations/working-branch.js';
import { branchTerm } from '../standing-assignments/term-rules.js';
import { addressedAgentId } from './fla-mention.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';

// Which line of work of its own project a task belongs to (docs/workstreams.md).
// Only lines of the project the task is already in apply, by the request's
// words, a folder below the repository root of the working directory, or the
// current Git branch; with none, a session whose last task belonged to a line
// goes on with it. One match makes the line's owner this turn's FLA
// (project-agent-task-entry.js); several ask the person; none leaves the task
// with the lead. Deterministic: no model, no Provider read.
//
// A task a line took keeps it in its Agent assignment's match basis,
// "workstream:<assignmentId> <notice>", read back by prefix and ID alone. The
// branch a session is on rides along as "working_branch:<name>" when it is a
// line's own kind of branch, so opening a line can record it.
//
// The repository ({ branch, root }) is read once, here, and handed to the
// task's beginning (WORKING_REPOSITORY), which reads it for the conversation's
// place and its continuation line (task-context-entry.js); nothing reads it twice.

// The working repository this entry read, carried to the task's beginning without reaching any client.
export const WORKING_REPOSITORY = Symbol('working_repository');

const WORKSTREAM = /^workstream:(\S+) (.+)$/su;
const WORKING_BRANCH = /^working_branch:(.+)$/su;
// An explicit Agent says who; naming the project only says where, so its lines still apply.
const EXPLICIT_AGENT_BASES = new Set(['explicit_agent', 'explicit_fla']);

export async function withWorkstream(application, resolution, input, sessionTask) {
  const projectId = resolution.status === 'matched' ? resolution.personalProjectId : null;
  if (!projectId || !application.standingAssignments || resolution.standingOwner || resolution.standingCandidates
    || resolution.fla || resolution.group) return resolution;
  const repository = await workingRepository(input.projectPath);
  const branch = repository?.branch ?? null;
  const carried = { workingRepository: repository, ...(branchTerm(branch) ? { workingBranch: branch } : {}) };
  if (input.projectAgentId || addressedAgentId(input.taskPrompt) !== null || EXPLICIT_AGENT_BASES.has(resolution.basis)
    || hostInternalActivity(application, input)) return { ...resolution, ...carried };
  const space = application.config.personal.spaceId;
  let lines;
  try {
    lines = application.standingAssignments.list(space).filter(line => line.projectId === projectId);
  } catch {
    return { ...resolution, ...carried };
  }
  if (!lines.length) return { ...resolution, ...carried };
  const matches = lineMatches(application, space, projectId, input, repository);
  if (matches.length > 1) return { ...resolution, ...carried, standingCandidates: matches.map(ownerOf) };
  if (matches.length === 1) return { ...resolution, ...carried, standingWorkstream: ownerOf(matches[0]) };
  const continued = sessionTask?.personalProjectId === projectId
    ? lines.find(line => line.assignmentId === taskWorkstreamId(sessionTask)) : null;
  return continued ? { ...resolution, ...carried,
    standingWorkstream: ownerOf({ assignment: continued, matchedTerms: [], matchedOn: ['session'] }) }
    : { ...resolution, ...carried };
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

function ownerOf({ assignment, matchedTerms, matchedOn }) {
  return { assignmentId: assignment.assignmentId, projectId: assignment.projectId, leadAgentId: assignment.leadAgentId,
    workstream: assignment.responsibility, matchedTerms, matchedOn };
}

/**
 * What the entry says about the line this task belongs to: who works on it
 * this turn, by name. Nothing when its owner was already the one chosen, so
 * a turn that never left its line gains no line about it.
 */
export function workstreamEntry(owner, selection) {
  if (!selection?.standingAgentApplied && !selection?.standingAgentUnreached) return null;
  const line = `工作线「${owner.workstream}」`;
  const ownerName = selection.standingOwnerName ?? owner.leadAgentId;
  const selected = agentName(selection.agent) ?? '组长';
  const notice = selection.standingAgentApplied ? `${line}由 ${ownerName} 接着做`
    : selection.standingUnreachedReason === 'workstream_owner_not_on_project'
      ? `${line}的负责人 ${ownerName} 已不在本项目，这次由 ${selected} 处理；可在项目页把这条线交给别人`
      : selection.standingUnreachedReason === 'client_not_allowed'
        ? `${line}的负责人 ${ownerName} 不能在当前客户端工作，这次由 ${selected} 处理`
        : `${line}的负责人 ${ownerName} 这次没能接上，由 ${selected} 处理`;
  return { notice, receiptNotice: receiptText(notice),
    field: { status: 'workstream', assignment_id: owner.assignmentId, workstream: owner.workstream,
      owner_agent_id: owner.leadAgentId, owner_name: ownerName, matched_terms: owner.matchedTerms,
      matched_on: owner.matchedOn ?? [],
      ...(selection.standingAgentUnreached ? { owner_resolved: false,
        reason: selection.standingUnreachedReason ?? 'unavailable' } : {}),
      notice } };
}

export const workstreamMarker = field => `workstream:${field.assignment_id} ${field.notice}`;

/** The notice a stored marker repeats in the checkpoint receipt, or null. */
export const workstreamNoticeOf = item => WORKSTREAM.exec(item)?.[2] ?? null;

function taskWorkstreamId(task) {
  return (task?.agentAssignment?.match_basis ?? []).map(item => WORKSTREAM.exec(item)?.[1]).find(Boolean) ?? null;
}

/** The marker that keeps a line's kind of branch on the task, or none. */
export function workingBranchMarkers(resolution) {
  return resolution?.workingBranch ? [`working_branch:${resolution.workingBranch}`] : [];
}

/** The branch the calling task's session was on, when it is a line's kind of branch. */
export function taskWorkingBranch(task) {
  return (task?.agentAssignment?.match_basis ?? []).map(item => WORKING_BRANCH.exec(item)?.[1]).find(Boolean) ?? null;
}

function agentName(agent) {
  return agent?.profile?.displayName || agent?.profile?.name || null;
}
