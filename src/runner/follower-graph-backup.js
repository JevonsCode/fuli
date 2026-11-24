import { consoleGraphBackup } from '../data-format/console-graph-backup.js';
import { personalGraphFormat } from '../data-format/graph-format-client.js';
import { dataFormatMigrations } from '../data-format/migration-operations.js';
import { readJson, sendJson } from '../http/response.js';
import { localGraphProjects } from './local-graph-projects.js';
import { FOLLOWER_FORMAT_PATH } from './follower-maintenance-paths.js';

export function followerGraphMaintenance(paths, { backups = consoleGraphBackup(paths.dataDir),
  projects = localGraphProjects, formats = dataFormatMigrations(paths.dataDir,
    { graph: personalGraphFormat(paths.dataDir), graphBackup: backups }) } = {}) {
  return async (request, response, url, ids) => {
    if (url.pathname === FOLLOWER_FORMAT_PATH) {
      if (request.method === 'GET') return sendJson(response, 200, await formats.preview());
      if (request.method === 'POST') {
        const { digest } = await readJson(request);
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Choose the format plan shown on this computer.');
        return sendJson(response, 200, await formats.apply({ digest, actor: { entrypoint: 'http' } }));
      }
    } else if (request.method === 'GET') {
      const local = await projects(paths.graphRuntimeConfigPath).catch(() => ({}));
      return sendJson(response, 200, { backups: await backups.followerBackups(), job: backups.status(),
        missingProjects: local.projects ? ids.filter(id => !local.projects.includes(id)) : null });
    } else if (request.method === 'POST') {
      const { action, name } = await readJson(request);
      if (action === 'backup') return sendJson(response, 202, await backups.startBackup({}));
      if (action === 'restore') return sendJson(response, 202, await backups.startRestore({ name }));
      throw new TypeError('Choose backup or restore.');
    }
    return sendJson(response, 405, { error: 'invalid_method' });
  };
}
