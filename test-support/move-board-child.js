import { join } from 'node:path';
import { JefaBoardStore } from '../src/employees/builtin/jefa/board-store.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { moveParticipant } from '../src/runner/move-participant.js';
import { MoveStore, PROJECT_MOVES_FILE } from '../src/runner/move-store.js';
import { RoutesStore, ROUTES_FILE, hostOwner, LOCAL_OWNER } from '../src/runner/routes-store.js';

process.once('message', async ({ dir, device, authority, move, ticket, phase, input, uri, token, interrupt }) => {
  const db = new MoveStore(join(dir, PROJECT_MOVES_FILE));
  const board = new JefaBoardStore(join(dir, 'board.sqlite'));
  const routes = new RoutesStore(join(dir, ROUTES_FILE));
  const provider = new GraphitiProviderClient({ baseUrl: uri, accessToken: token });
  try {
    const interruptAfter = step => {
      if (interrupt === step) process.kill(process.pid, 'SIGKILL');
    };
    const installBoard = board.installForMove.bind(board);
    board.installForMove = (...args) => {
      const digest = installBoard(...args);
      interruptAfter('install-board');
      return digest;
    };
    const run = moveParticipant({ store: db, dataDir: dir, device, authority, space: move.space, board,
      decision: async () => ticket, inspect: request => provider.projectHandoverProof(request),
      handover: async request => {
        const reply = await provider.projectHandover(request);
        interruptAfter(request.phase);
        return reply;
      },
      installRoute: (record, local) => {
        routes.installMove('project:' + record.project, local ? LOCAL_OWNER : hostOwner(record.target));
        interruptAfter(local ? 'target-route' : 'source-route');
      } });
    process.send(await run(phase, move, input));
  } catch (error) {
    process.send({ ok: false, code: error.details?.code ?? error.code ?? 'test_participant_failed', status: error.status });
  } finally {
    db.close(); board.close(); routes.close(); process.disconnect();
  }
});
