import { join, resolve } from 'node:path';

import { localWriteAdmission } from '../../../runner/project-write-gate.js';
import { JefaBoardStore } from './board-store.js';
import { handleJefaHttp } from './http.js';
import { callJefaTool, describeJefaTools } from './tools.js';

// Jefa's board runtime, shipped with FULI: the same Manifest API v1 contract
// an installed employee package implements (docs/employee-agents.md), so the
// package registry loads it like one and needs no install step.
const JEFA_BOARD_FILE = 'board.sqlite';

export function createEmployeeRuntime({ dataDirectory, manifest }) {
  const store = new JefaBoardStore(join(dataDirectory, JEFA_BOARD_FILE), {
    admit: scope => localWriteAdmission(resolve(dataDirectory, '../../..'), scope.spaceId, [scope.projectId])
  });
  return {
    describeTools: describeJefaTools,
    callTool: async (name, input, context) => callJefaTool(store, name, input, context),
    handleHttp: (request, response, context) => handleJefaHttp(store, manifest, request, response, context),
    close: async () => store.close()
  };
}
