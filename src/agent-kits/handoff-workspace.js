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
  const session = directory(locateSession(actor.client, actor.sessionId));
  if (session && matches(session)) return session;
  const projectFolder = actor.projectId && directory(await app.roundtable?.knownProjectFolder?.(actor));
  if (projectFolder && matches(projectFolder)) return projectFolder;
  const projects = await app.listPersonalProjects({ personalSpaceId: app.config.personal.spaceId });
  for (const project of projects) {
    for (const source of ownRepositorySources(project)) {
      const folder = localSource(source.uri);
      if (folder && matches(folder)) return folder;
    }
  }
  throw new InvalidInputError('Choose a FULI project folder or the current session folder. 请选择已登记的项目目录或当前会话目录。');
}
