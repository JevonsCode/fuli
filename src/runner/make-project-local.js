import { basename, isAbsolute } from 'node:path';

import { resolvePersonalProjectPath } from '../graphiti/project-path-context.js';
import { projectOwners } from './call-routes.js';
import { readLocalRuntime } from './follower-local-runtime.js';
import { answerCode } from './local-answer-note.js';
import { localRouteRefusal } from './local-route-refusal.js';
import { resultValue } from './offline-calls.js';
import { GLOBAL_SCOPE, PROJECT_PREFIX, scopeName } from './routes-store.js';

// Making a new project this computer's (docs/runner-roles-design.md §12): one
// way, whether the person asks through the console, the CLI or their AI
// (follower-tools.js). Only a project the host does not have, and only while
// the host can say so:
//
// 1. this computer may own a project (local-route-refusal.js: its own runtime
//    ready, under the host's space; while that refuses, nothing below runs and
//    nothing is written), the host applies writes to global from it
//    (globalWrites in its hello), and its first copy of global arrived;
// 2. the host is asked which projects it has, and none of them is this
//    folder (the host's own resolver), this id or this name; with the host
//    away nothing is made, since the host could make the same id meanwhile;
// 3. the project is made here (createOnly: an existing one is never replaced);
// 4. only then is it routed here, with its folder. A project made here whose
//    route was never written (the process ended between) gets its route the
//    next time, as the host still has no such project.
//
// local: this computer's own half (local-scope-server.js); hostProjects(spaceId):
// the host's projects as it lists them, or null while it is away.
// Answers { status: 'local', scope, folder, made } or { refused: { code, message } }.
export async function makeProjectLocal({ dataDir, routes, store, folder = null, projectId = null, name = null,
  hostWritesGlobal, hostProjects, local, refusal = localRouteRefusal, readRuntime = readLocalRuntime }) {
  if (folder !== null && (typeof folder !== 'string' || !isAbsolute(folder))) {
    return refused('invalid_input', 'projectPath must be the project\'s absolute folder on this computer.',
      'projectPath 要写这个项目在这台电脑上的完整（绝对）路径。');
  }
  const id = projectId ?? (folder ? basename(folder) : null);
  const scope = id ? scopeName(`${PROJECT_PREFIX}${id}`) : null;
  if (!scope) return refused('invalid_input', 'Name the folder (projectPath) or the project id to keep on this computer.',
    '说明要放在这台电脑上的文件夹（projectPath）或项目 ID。');
  const host = store.host();
  const hostName = host?.name ?? 'the host';
  const waiting = openingRefusal({ dataDir, routes, store, scope, hostWritesGlobal, refusal, readRuntime });
  if (waiting) return { refused: waiting };

  const app = await local.application();
  const spaceId = app.config.personal.spaceId;
  const answered = await hostProjects(spaceId);
  const listed = answered ? projectsIn(answered) : null;
  if (!listed) {
    return refused('host_needed_to_check', `${hostName} must first say it has no such project, so it is made here only `
      + 'while the two computers are connected. Nothing was changed; try again once they are.',
    `要先确认 ${hostName} 上没有这个项目，等两台电脑连上再试。什么都没改。`);
  }
  const projectName = name ?? id;
  const clash = listed.find((project) => project?.project_id === id
    || (typeof project?.name === 'string' && project.name === projectName))
    ?? (folder ? folderOnHost(folder, listed) : null);
  if (clash) {
    // Said as `fuli routes local` says a project the host has (and what to do: keep using that one).
    const answer = localRouteRefusal({ scope: `${PROJECT_PREFIX}${clash.project_id ?? id}`, hostName,
      hostProjects: [clash.project_id ?? id], localRuntime: readRuntime(dataDir) });
    return { refused: { code: answer.code, message: answer.message } };
  }
  // Made here before, its route never written: this is that project, and only its route is missing.
  const here = await local.call('list_personal_projects', { personalSpaceId: spaceId, projectId: id });
  if (here?.isError) return { refused: localRefusal(here) };
  const madeBefore = projectsIn(resultValue(here)).some((project) => project?.project_id === id);
  if (!madeBefore) {
    const made = await local.call('upsert_personal_project', { personalSpaceId: spaceId, projectId: id, createOnly: true,
      profile: { name: projectName, scope: `The work in the folder ${folder ? basename(folder) : id}, kept on this computer.`,
        ...(folder ? { sources: [{ key: 'folder', kind: 'repository', role: 'own', title: basename(folder), uri: folder }] } : {}) } });
    if (made?.isError) return { refused: localRefusal(made) };
  }
  routes.setLocalProject(scope, folder);
  return { status: 'local', scope, folder, made: !madeBefore };
}

// Why no project can be made this computer's now, or null when one can
// (step 1): what the console and the tool list read before anything is asked.
// scope: the project asked for, or none (whether any could be).
export function openingRefusal({ dataDir, routes, store, scope = null, hostWritesGlobal, refusal = localRouteRefusal,
  readRuntime = readLocalRuntime }) {
  const host = store.host();
  const hostName = host?.name ?? 'the host';
  // The projects known to be the host's matter only for one asked for by name.
  const hostIds = scope ? projectOwners(routes, store, { hostName, hostFingerprint: host?.fingerprint ?? null })
    .filter((project) => project.where === 'host').map((project) => project.id) : [];
  const first = refusal({ scope: scope ?? `${PROJECT_PREFIX}`, hostName, hostProjects: hostIds, localRuntime: readRuntime(dataDir) });
  if (first) return first;
  if (!hostWritesGlobal) {
    return refusal_('host_needs_update', `FULI on ${hostName} is too old to take what a project here writes to global `
      + `(your habits, the FLA roster); update FULI on ${hostName} first.`, `${hostName} 的 FULI 版本旧，收不了本机项目写给全局的内容；先更新 ${hostName}。`);
  }
  if (!routes.hasReplica(GLOBAL_SCOPE)) {
    return refusal_('waiting_for_copy', `This computer is waiting for its first copy of global from ${hostName}; it arrives `
      + 'by itself once the two computers are connected.', `这台电脑在等 ${hostName} 的第一份全局副本，两台电脑连上后会自动到。`);
  }
  return null;
}

// The host's project this folder is, by the host's own resolver, or null.
function folderOnHost(folder, projects) {
  try {
    const resolution = resolvePersonalProjectPath(folder, projects);
    return resolution?.status === 'matched' ? projects.find((project) => project.project_id === resolution.personalProjectId)
      ?? { project_id: resolution.personalProjectId } : null;
  } catch { return null; }
}

// The projects a list_personal_projects answer holds, however it is wrapped.
function projectsIn(value) {
  if (Array.isArray(value)) return value;
  for (const field of ['projects', 'items', 'result']) if (Array.isArray(value?.[field])) return value[field];
  return [];
}

// This computer's own FULI refused: its code and message as it said them.
function localRefusal(answer) {
  const value = resultValue(answer);
  return { code: answerCode(answer) ?? 'local_project_not_made',
    message: String(value?.error?.message ?? value?.message ?? 'This computer\'s FULI did not make the project.') };
}

function refusal_(code, en, zh) {
  return { code, message: `${en}\n${zh}` };
}

function refused(code, en, zh) {
  return { refused: refusal_(code, en, zh) };
}
