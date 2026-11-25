import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeJsonFileAtomic } from '../storage/json-file.js';
import { INSTALLATION_FILE, holdInstallation } from './project-installation.js';

// Compose reads this local override in every managed start, wake and restore.
// Only the runner's control directory is mounted into the personal Provider.
export function installationComposeFiles(paths) {
  if (!paths.dataDir) return [];
  const path = join(paths.dataDir, INSTALLATION_FILE);
  if (!existsSync(path)) {
    holdInstallation(paths.dataDir)?.();
    return [];
  }
  const directory = dirname(path);
  const file = join(directory, 'project-installation.compose.json');
  const mount = '/fuli-runner';
  const config = { services: { 'personal-provider': {
    environment: { FULI_PROJECT_INSTALLATION_DIRECTORY: mount },
    volumes: [{ type: 'bind', source: directory, target: mount }]
  } } };
  const expected = JSON.stringify(config, null, 2) + '\n';
  if (!existsSync(file) || readFileSync(file, 'utf8') !== expected) writeJsonFileAtomic(file, config);
  return ['-f', file];
}
