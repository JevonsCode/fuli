import { join } from 'node:path';

import { ApplicationError } from '../app/application-error.js';
import { detachedJob } from './detached-job.js';

// The console operations that stop and start FULI, each a detached job
// (detached-job.js) journaled in the data directory: the update
// (console-update.js), a whole-store restore (data-format/console-restore.js)
// and the graph step's backup or restore (data-format/console-graph-backup.js).
// Two at once would stop and start FULI under each other, so none starts while
// another runs, and the refusal names the one that runs.
export const RESTARTING_JOBS = Object.freeze({
  update: { journal: 'console-update.json', running: new Set(['updating']) },
  restore: { journal: 'format-restore.json', running: new Set(['stopping', 'restoring', 'starting']) },
  graph: { journal: 'format-graph-backup.json', running: new Set(['running']) }
});

const RUNNING = Object.freeze({
  update_running: 'FULI is being updated',
  format_restore_running: 'A store is being restored',
  graph_backup_running: 'The graph is being backed up',
  graph_restore_running: 'The graph is being restored'
});

// The code of the job of this kind that runs now, or null.
export function runningJob(dataDir, kind) {
  const { journal, running } = RESTARTING_JOBS[kind];
  const job = detachedJob(join(dataDir, journal), { running }).read();
  if (!running.has(job?.status)) return null;
  return kind === 'graph' ? `graph_${job.action}_running` : kind === 'update' ? 'update_running' : 'format_restore_running';
}

export function restartingJobError(code, then) {
  return new ApplicationError(code, `${RUNNING[code]}, which stops and starts FULI too; ${then} once it is done. Nothing was changed.`,
    { status: 409 });
}

// Before a job of this kind starts: refused while one of the others runs.
export function refuseWhileRestarting(dataDir, own) {
  for (const kind of Object.keys(RESTARTING_JOBS)) {
    const code = kind === own ? null : runningJob(dataDir, kind);
    if (code) throw restartingJobError(code, 'start this');
  }
}
