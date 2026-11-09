import { DESKTOP_SOURCE, desktopCallSource } from './claude-desktop/code-tab-token-source.js';

// The client one MCP call runs as. A connection runs as the client it was
// started for, except where that client's process also serves another
// client's sessions: Claude Desktop's serves its Code tab (rec#107).
const RESOLVERS = Object.freeze({ [DESKTOP_SOURCE]: desktopCallSource });

export async function callSourceApplication(app, sourceApplication, input) {
  const resolve = RESOLVERS[sourceApplication];
  return resolve ? resolve(app, input) : sourceApplication;
}
