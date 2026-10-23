import { join } from 'node:path';
import { createJudgmentService } from './service.js';
import { JudgmentStore } from './store.js';
import { createJudgmentEngine } from './engine.js';
import { createJudgmentBackend } from './backend.js';
import { openRoleWorkRuntime } from '../model-backends/runtime.js';
import { roleWorkSessions } from '../graphiti/role-work-sessions.js';
import { createKnowledgeRecoveryGate } from '../knowledge-hard-delete/recovery-gate.js';

// The two local text stores share one process-local proof for this data directory.
// app.modelTrust: whether Tonborg's configured model may apply a review by itself (rec#10 D-36).
export function attachJudgmentRuntime(app, paths) {
  const recoveryGate = createKnowledgeRecoveryGate({ dataDir: paths.dataDir,
    readWatermark: input => app.personal.readHardDeletionWatermark(input) });
  app.knowledgeRecoveryGate = recoveryGate;
  app.roleWork = openRoleWorkRuntime(paths, { port: app.modelBackends, verifySession: roleWorkSessions(app), recoveryGate,
    resumers: { tonborg: work => app.judgment.resumeWork(work) } });
  app.judgment = createJudgmentService({ app, prepareStore: spaceId => recoveryGate.refresh(spaceId),
    openStore: () => new JudgmentStore(join(paths.dataDir, 'judgment.sqlite'), { recoveryGate }),
    engine: createJudgmentEngine({ app, judge: createJudgmentBackend({ bridge: app.roleWork }), trust: app.modelTrust }) });
}
