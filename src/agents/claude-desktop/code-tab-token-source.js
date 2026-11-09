import { ProviderRequestError } from '../../graphiti/provider-client.js';

// rec#107. Claude Desktop runs FULI from its own configuration as one MCP
// process (`--source-application claude`), and that process can also serve a
// session in its Code tab, whose prompt hook is Claude Code's and begins the
// task as `claude_code`. Every call carrying that hook's token was refused as
// another client's, and the connection could begin no task of its own (it
// proves no native session), so the Agent could neither checkpoint nor answer
// on the roundtable. A call through this connection that carries a token the
// Provider holds for `claude_code` runs as `claude_code`; any other call, and
// every token of another client, keeps `claude`.
export const DESKTOP_SOURCE = 'claude';
const CODE_TAB_SOURCE = 'claude_code';

export async function desktopCallSource(app, input) {
  const token = input?.taskContextToken;
  if (typeof token !== 'string' || !token || typeof app?.taskContextRegistry?.context !== 'function') return DESKTOP_SOURCE;
  try {
    await app.taskContextRegistry.context(token, CODE_TAB_SOURCE);
    return CODE_TAB_SOURCE;
  } catch (error) {
    // 404: not a Code-tab token (this client's own, superseded or unknown); the call decides as itself.
    if (error instanceof ProviderRequestError && error.status === 404) return DESKTOP_SOURCE;
    throw error;
  }
}
