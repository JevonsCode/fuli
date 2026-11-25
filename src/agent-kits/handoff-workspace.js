import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionWorkingDirectory } from '../../packages/roundtable/src/roundtable/wake.js';
import { InvalidInputError } from '../app/application-error.js';
import { ownRepositorySources } from '../graphiti/repository-remote.js';

function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /^[/\\]{2}/u.test(path)) return null;
  try {
    const real = realpathSync.native(path);
    return statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

function localSource(uri) {
  if (typeof uri !== 'string') return null;
  if (!uri.startsWith('file:')) return directory(uri);
  try { return directory(fileURLToPath(uri)); } catch { return null; }
}

// Only open the caller's recorded session folder or a folder FULI already
// associates with a project. Compare exact real directories, including links.
export async function handoffWorkspace(app, actor, path, locateSession = sessionWorkingDirectory) {
  const wanted = directory(path);
  if (!wanted) throw new InvalidInputError('Choose an existing absolute project folder. 请选择已存在的项目绝对路径。');
  return findHandoffWorkspace(app, actor, candidate => candidate === wanted, locateSession);
}

export async function findHandoffWorkspace(app, actor, matches, locateSession = sessionWorkingDirectory) {
  const projectFolder = actor.projectId && directory(await app.roundtable?.knownProjectFolder?.(actor));
  if (projectFolder && matches(projectFolder)) return { cwd: projectFolder, projectId: actor.projectId };
  const session = directory(locateSession(actor.client, actor.sessionId));
  const projects = await app.listPersonalProjects({ personalSpaceId: app.config.personal.spaceId });
  const registered = new Map();
  for (const project of projects) {
    for (const source of ownRepositorySources(project)) {
      const cwd = localSource(source.uri);
      if (cwd && matches(cwd)) {
        const projectId = project.project_id ?? project.personal_project_id ?? project.id;
        if (projectId) registered.set(projectId, cwd);
      }
    }
  }
  if (registered.size === 1) {
    const [[projectId, cwd]] = registered;
    return { cwd, projectId };
  }
  if (!registered.size && session && matches(session)) return { cwd: session, projectId: null };
  throw new InvalidInputError('Choose an unambiguous FULI project folder or the current session folder. 请选择归属明确的项目目录或当前会话目录。');
}
