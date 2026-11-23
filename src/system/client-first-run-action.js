import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { clientFirstRun } from '../agents/client-first-run.js';
import { InvalidInputError } from '../app/application-error.js';
import { assertJsonObject } from '../validation/values.js';

// The one step FULI takes for a client's first-run question, on the person's
// click on this computer (client-first-run.js): for Cursor, its own
// `cursor-agent mcp enable fuli` in the folder the person named, which
// enables FULI's own MCP entry there and nothing else. The card shows the
// command before it runs; the answer says what happened, including a CLI that
// did not answer in time. locate(program): cli-presence.js's locate.
export function createClientFirstRunAction({ locate }) {
  let busy = false;
  return async (input) => {
    assertJsonObject(input, 'Client first run');
    if (Object.keys(input).sort().join() !== 'clientId,folder' || typeof input.clientId !== 'string' || typeof input.folder !== 'string') {
      throw new InvalidInputError('Expected only a clientId and a folder');
    }
    const step = clientFirstRun(input.clientId);
    if (!step) throw new InvalidInputError('This client has no first-run step');
    const folder = input.folder.trim();
    if (!isAbsolute(folder) || folder.length > 4096 || !existsSync(folder) || !statSync(folder).isDirectory()) {
      throw new InvalidInputError('folder must be an existing absolute folder on this computer');
    }
    if (busy) throw new InvalidInputError('A first-run step is already running');
    busy = true;
    try {
      return { id: input.clientId, ...await step.run(folder, { locate }) };
    } finally { busy = false; }
  };
}
