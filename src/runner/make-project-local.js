import { basename, isAbsolute } from 'node:path';

import { resolvePersonalProjectPath } from '../graphiti/project-path-context.js';
import { fuliUnavailableGuidance } from '../local-runtime/unavailable-guidance.js';
import { knownProjects, openRoutes, projectOwners, realFolder } from './call-routes.js';
import { readLocalRuntime } from './follower-local-runtime.js';
import { hostTakesGlobalWrites } from './global-writes-outbox.js';
import { answerCode } from './local-answer-note.js';
import { localRouteRefusal } from './local-route-refusal.js';
import { ownRuntimeRunning, RUNTIME_WAIT_MS, startMakingProject } from './making-project.js';
import { resultValue } from './offline-calls.js';
import { recordOwnedProject } from './owned-project-routes.js';
import { RUNNER_PATHS } from './protocol.js';
import { GLOBAL_SCOPE, LOCAL_OWNER, PROJECT_PREFIX, scopeName } from './routes-store.js';

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
// 3. this computer's graph is started for it (making-project.js), and the
//    project is made there (createOnly: an existing one is never replaced);
// 4. only then is it routed here, with its folder. A project made here whose
//    route was never written (the process ended between) gets its route the
//    next time, as the host still has no such project.
//
// local: this computer's own half (local-scope-server.js); hostProjects(spaceId):
// the host's projects as it lists them, null while it is away, or { hostError: code }
// when it answered with an error; hostWritesGlobal: whether the host applies writes
// to global, or a function asking it (null while it is away), called only once step 1's
// own checks pass (hostQuestions asks both over the pairing). awaitRuntime(dataDir):
// whether this computer's graph runs for the project, once asked for.
// Answers { status: 'local', scope, folder, made } or { refused: { code, message } }.
export async function makeProjectLocal({ dataDir, routes, store, folder = null, projectId = null, name = null,
  hostWritesGlobal, hostProjects, local, refusal = localRouteRefusal, readRuntime = readLocalRuntime,
  awaitRuntime = ownRuntimeRunning }) {
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
  const closed = runtimeRefusal({ dataDir, routes, store, scope, refusal, readRuntime });
  if (closed) return { refused: closed };
  const writes = typeof hostWritesGlobal === 'function' ? await hostWritesGlobal() : hostWritesGlobal;
  if (writes === null) return hostNeeded(hostName);
  const waiting = hostRefusal({ routes, hostName, hostWritesGlobal: writes });
  if (waiting) return { refused: waiting };

  const app = await local.application();
  const spaceId = app.config.personal.spaceId;
  const answered = await hostProjects(spaceId);
  if (answered?.hostError) return hostCouldNotCheck(hostName, answered.hostError);
  if (answered == null) return hostNeeded(hostName);
  const listed = projectsIn(answered);
  if (!listed) return refused('host_could_not_check',
    `The project list from ${hostName} was incomplete. Try again when the full list is available.`,
    `${hostName} 返回的项目列表不完整。等能读取完整列表后再试。`);
  const projectName = name ?? id;
  let hostProjectId = listed.find(project => project.project_id === id || project.name === projectName)?.project_id;
  if (!hostProjectId && folder) {
    let resolution;
    try { resolution = resolvePersonalProjectPath(folder, listed); } catch {
      return refused('invalid_input', 'Choose an existing project folder on this computer.', '请选择这台电脑上已有的项目文件夹。');
    }
    if (resolution.status === 'ambiguous') return refused('project_folder_ambiguous',
      'This folder matches more than one project on the host. Choose the project folder itself.',
      '这个文件夹与主机上的多个项目匹配。请选择项目本身的文件夹。');
    if (resolution.status === 'matched') hostProjectId = resolution.personalProjectId;
  }
  if (hostProjectId) {
    // Said as `fuli routes local` says a project the host has (and what to do: keep using that one).
    const answer = localRouteRefusal({ scope: `${PROJECT_PREFIX}${hostProjectId}`, hostName,
      hostProjects: [hostProjectId], localRuntime: readRuntime(dataDir) });
    return { refused: { code: answer.code, message: answer.message } };
  }
  const finish = startMakingProject(dataDir, scope);
  if (!finish) return refused('project_creation_busy', 'Another project is being opened here. Try again when it finishes.',
    '这台电脑正在建立另一个项目，请在完成后重试。');
  try {
    const ownRoutes = routes.all().filter(row => row.owner === LOCAL_OWNER && row.scope.startsWith(PROJECT_PREFIX));
    const existing = ownRoutes.find(row => row.scope === scope);
    const canonical = realFolder(folder);
    if (folder && ownRoutes.some(row => row.folder && row.scope !== scope && realFolder(row.folder) === canonical)) {
      return refused('project_folder_in_use', 'This folder already belongs to a local project.', '这个文件夹已经属于一个本机项目。');
    }
    if (existing) {
      if (folder && realFolder(existing.folder) !== canonical) return refused('project_folder_differs',
        'This local project is already registered with a different folder.', '这个本机项目已经登记在另一个目录。');
      return { status: 'local', scope, folder: existing.folder ?? null, made: false };
    }
    if (!await awaitRuntime(dataDir)) return { refused: runtimeNotRunning(dataDir) };
    // Made here before, its route never written: this is that project, and only its route is missing.
    const here = await local.call('list_personal_projects', { personalSpaceId: spaceId, projectId: id });
    if (here?.isError) return { refused: localRefusal(here) };
    const ownProjects = projectsIn(resultValue(here));
    if (!ownProjects) return refused('local_could_not_check',
      'The project list on this computer was incomplete. Try again when the full list is available.',
      '这台电脑的项目列表不完整。等能读取完整列表后再试。');
    const madeBefore = ownProjects.some(project => project.project_id === id);
    if (!madeBefore) {
      // A crash after the graph write and before the route must still protect the graph at leave.
      recordOwnedProject(dataDir, scope);
      const made = await local.call('upsert_personal_project', { personalSpaceId: spaceId, projectId: id, createOnly: true,
        profile: { name: projectName, scope: `The work in the folder ${folder ? basename(folder) : id}, kept on this computer.`,
          ...(folder ? { sources: [{ key: 'folder', kind: 'repository', role: 'own', title: basename(folder), uri: folder }] } : {}) } });
      if (made?.isError) return { refused: localRefusal(made) };
    }
    routes.setLocalProject(scope, folder);
    recordOwnedProject(dataDir, scope);
    return { status: 'local', scope, folder, made: !madeBefore };
  } finally {
    finish();
  }
}

// makeProjectLocal for a process with no MCP session to the host of its own
// (the follower console's 「放在这台电脑」, `fuli routes local`): the host is
// asked over the pairing (hostQuestions) and the project made through this
// computer's own half, opened for this one call. Same answer as makeProjectLocal.
export async function makeProjectHere({ dataDir, store, connection, folder = null, projectId = null, name = null,
  sourceApplication = 'other', sessionId }) {
  // Loaded only now: the MCP core is not loaded by a process that makes no project.
  const { createLocalScopeServer } = await import('./local-scope-server.js');
  const routes = openRoutes(dataDir);
  const local = createLocalScopeServer({ dataDir, sourceApplication, toolProfile: 'full', sessionId });
  try {
    return await makeProjectLocal({ dataDir, routes, store, folder, projectId, name, local, ...hostQuestions(connection) });
  } finally {
    try { await local.close(); } finally { routes.close(); }
  }
}

// Why no project can be made this computer's now, or null when one can
// (step 1): what the console and the tool list read before anything is asked.
// scope: the project asked for, or none (whether any could be).
export function openingRefusal({ dataDir, routes, store, scope = null, hostWritesGlobal, refusal = localRouteRefusal,
  readRuntime = readLocalRuntime }) {
  return runtimeRefusal({ dataDir, routes, store, scope, refusal, readRuntime })
    ?? hostRefusal({ routes, hostName: store.host()?.name ?? 'the host', hostWritesGlobal });
}

// What the follower's own page offers (follower-own-projects-page.js): why no
// project can be kept here now, or else the folders recently worked in here
// that no project is known for yet (at most CHOICES, newest first); and the
// projects this computer owns, with their folders.
const CHOICES = 8;
export function keepProjectChoices({ dataDir, store, hostWritesGlobal, readRuntime = readLocalRuntime }) {
  const routes = openRoutes(dataDir);
  try {
    const refusal = openingRefusal({ dataDir, routes, store, hostWritesGlobal, readRuntime });
    const localProjects = routes.all().filter((row) => row.owner === LOCAL_OWNER && row.scope.startsWith(PROJECT_PREFIX))
      .map((row) => ({ id: row.scope.slice(PROJECT_PREFIX.length), scope: row.scope, folder: row.folder ?? null }));
    if (refusal) return { refusal, folders: [], localProjects };
    const ofProjects = new Set(knownProjects(store, routes).map((project) => project.folder).filter(Boolean));
    const folders = [];
    for (const { key } of store.taskEntries()) {
      const folder = /^entry:[^:]+:(.+)$/.exec(key)?.[1];
      if (folder && isAbsolute(folder) && !ofProjects.has(folder) && !folders.includes(folder)) folders.push(folder);
      if (folders.length === CHOICES) break;
    }
    return { refusal: null, folders, localProjects };
  } finally {
    routes.close();
  }
}

// Step 1 on this computer alone (local-route-refusal.js), asked before the host is.
function runtimeRefusal({ dataDir, routes, store, scope, refusal, readRuntime }) {
  const host = store.host();
  const hostName = host?.name ?? 'the host';
  // The projects known to be the host's matter only for one asked for by name.
  const hostIds = scope ? projectOwners(routes, store, { hostName, hostFingerprint: host?.fingerprint ?? null })
    .filter((project) => project.where === 'host').map((project) => project.id) : [];
  return refusal({ scope: scope ?? `${PROJECT_PREFIX}`, hostName, hostProjects: hostIds, localRuntime: readRuntime(dataDir) });
}

// Step 1 as the host stands: it applies writes to global, and its first copy of global arrived.
// hostWritesGlobal null: the host not reached yet, so whether it takes them is not known.
function hostRefusal({ routes, hostName, hostWritesGlobal }) {
  if (hostWritesGlobal === null) return hostNeeded(hostName).refused;
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

// A bounded MCP result can contain a valid prefix of the directory. Only a
// complete directory can show that a project is absent.
function projectsIn(value) {
  if (value?.truncated) return null;
  const rows = Array.isArray(value) ? value : [value?.projects, value?.items, value?.result].find(Array.isArray);
  return rows?.every(project => typeof project?.project_id === 'string' && project.project_id.trim()) ? rows : null;
}

// The host answered, but not with which projects it has.
function hostCouldNotCheck(hostName, code) {
  return refused('host_could_not_check', `${hostName} answered with an error (${code}) when asked which `
    + 'projects it has, so nothing was made here. Try again in a while; if it keeps happening, look at FULI on '
    + `${hostName}.`, `问 ${hostName} 有哪些项目时，它那边出错了，所以这里什么都没建。过一会儿再试；一直这样就看看 ${hostName} 上的 FULI。`);
}

// This computer's own FULI refused: its code and message as it said them.
function localRefusal(answer) {
  const value = resultValue(answer);
  return { code: answerCode(answer) ?? 'local_project_not_made',
    message: String(value?.error?.message ?? value?.message ?? 'This computer\'s FULI did not make the project.') };
}

// What step 1 and 2 ask the host, over this computer's pairing with it
// (host-connection.js): whether it takes writes to global, and its projects
// as its console lists them. The console directory is shared by all three
// entry points and does not apply an MCP chat profile's display limit.
export function hostQuestions(connection) {
  return {
    hostWritesGlobal: async () => {
      const host = await connection.hello({ fresh: true });
      return host ? hostTakesGlobalWrites(host) : null;
    },
    hostProjects: async (personalSpaceId) => {
      const answer = await connection.getText(`${RUNNER_PATHS.console}/api/personal-projects?personalSpaceId=`
        + encodeURIComponent(personalSpaceId), { maxBytes: 4 * 1024 * 1024 }).catch(() => null);
      if (answer?.revoked) return { hostError: 'runner_revoked' };
      if (!answer?.reachable) return null;
      if (answer.tooLarge) return { hostError: 'project_directory_too_large' };
      if (answer.status !== 200) return { hostError: `http_${answer.status}` };
      try { return JSON.parse(answer.text); } catch { return { hostError: 'unreadable_answer' }; }
    }
  };
}

// This computer's graph did not start for the project: what FULI here needs, as an AI is told it everywhere.
function runtimeNotRunning(dataDir) {
  const guidance = fuliUnavailableGuidance(dataDir);
  return { code: 'local_runtime_not_running', message: `This computer's own graph did not start for the project within `
    + `${RUNTIME_WAIT_MS / 1000} s, so nothing was made. FULI on this computer starts it; ${guidance || 'start FULI here and try again.'}\n`
    + `这台电脑自己的图谱没有在 ${RUNTIME_WAIT_MS / 1000} 秒内为这个项目启动，所以什么都没建。图谱由这台电脑上的 FULI 启动，启动 FULI 后再试。` };
}

// The host is away: it must first say it has no such project.
function hostNeeded(hostName) {
  return refused('host_needed_to_check', `${hostName} must first say it has no such project, so it is made here only `
    + 'while the two computers are connected. Nothing was changed; try again once they are.',
  `要先确认 ${hostName} 上没有这个项目，等两台电脑连上再试。什么都没改。`);
}

function refusal_(code, en, zh) {
  return { code, message: `${en}\n${zh}` };
}

function refused(code, en, zh) {
  return { refused: refusal_(code, en, zh) };
}
