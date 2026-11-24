import { homedir } from 'node:os';
import { join } from 'node:path';

import { detectClients } from '../agent-kits/client-detection.js';
import { InvalidInputError } from '../app/application-error.js';
import { revealPath } from '../desktop/reveal-path.js';
import { assertJsonObject } from '../validation/values.js';

// Shows, in Finder or Explorer, the configuration file of a client whose FULI
// entry agent-installer could not use (an unreadable file: 「配置文件有问题」).
// Connecting again would fail the same way; the person fixes the file. The
// path is the one agent-installer reports for that client now, never one the
// request names, and the file is only shown, never opened or run.
export function createClientFileReveal({ installer, homeDir = homedir(), reveal = revealPath }) {
  return async (input) => {
    assertJsonObject(input, 'Client file');
    if (Object.keys(input).length !== 1 || typeof input.clientId !== 'string') throw new InvalidInputError('Expected only a clientId');
    const answer = await detectClients(installer);
    const client = answer.status === 'available' ? answer.clients.find(({ id }) => id === input.clientId) : null;
    const shown = client?.entryProblem ? client.entryPaths[0] : null;
    if (!shown) throw new InvalidInputError('This client has no configuration file to show');
    const path = shown === '~' ? homeDir : shown.startsWith('~/') ? join(homeDir, shown.slice(2)) : shown;
    return { id: input.clientId, ...await reveal(path) };
  };
}
