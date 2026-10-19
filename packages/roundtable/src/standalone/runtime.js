import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPeerPort } from '../peer/peer-port.js';
import { createAgentRoundtable } from '../roundtable/service.js';
import { createRoundtableStore } from '../roundtable/store.js';
import { createStandaloneHost } from './host.js';
import { createStandaloneStore } from './store.js';

// Where a standalone install keeps everything: one folder per person.
export function standaloneHome({ home = null, env = process.env } = {}) {
  return resolve(home ?? env.FULI_ROUNDTABLE_HOME ?? join(homedir(), '.fuli-roundtable'));
}

// Opens a standalone home: its directory and keys, Roundtable's own store, and
// the peer port for paired computers. Every process opens the same files.
export function openStandalone({ home, env = process.env }) {
  const store = createStandaloneStore(join(home, 'standalone.sqlite'));
  const host = createStandaloneHost({ store });
  const peer = createPeerPort({ dataDir: home, host });
  const roundtable = createAgentRoundtable({ host, peer, env,
    openStore: () => createRoundtableStore(join(home, 'roundtable.sqlite')) });
  return { home, store, host, peer, roundtable,
    async close() { await roundtable.close(); peer.close(); store.close(); } };
}
