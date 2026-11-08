import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import { flaMenuSettings, readFlaMenuEntries } from '../graphiti/fla-menu-reader.js';

// The person's FLAs as MCP prompts (11-08), which Claude Code, OpenCode and
// Cursor list in their / menu: typing /fla shows each as
// "name — project — role", and choosing one sends `#FLA <name>` (fla-menu.js).
// The list is read when the client asks for it; while the client holds one,
// the setting and language are checked every few seconds and the roster
// every minute, and a change tells the client to read the list again. Off
// in the settings, the list is empty. Nothing is written into the client.
// The client's own requests hold a runtime lease; the background check does
// not, so an idle graph runtime is never kept awake by it (it just fails).

const SETTINGS_EVERY_MS = 5_000;
const ROSTER_EVERY = 12;

export function registerFlaMenuPrompts(server, application, { sourceApplication, settingsEveryMs = SETTINGS_EVERY_MS,
  rosterEvery = ROSTER_EVERY, withRuntimeLease = (_owner, operation) => operation(), onError = () => {} } = {}) {
  const settings = () => flaMenuSettings(application);
  const read = () => readFlaMenuEntries(application, sourceApplication);
  let shown = null;
  let seenSettings = null;
  // Only what the client shows counts: a new order alone announces nothing.
  const remember = entries => {
    shown = JSON.stringify([...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
    seenSettings = JSON.stringify(settings());
    return entries;
  };

  server.server.registerCapabilities({ prompts: { listChanged: true } });
  // An unreadable roster lists nothing for now; the next check announces the real list.
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: remember(await withRuntimeLease('mcp-prompt:fla-menu', read).catch(error => { onError(error); return []; }))
      .map(({ name, title, description }) => ({ name, title, description }))
  }));
  server.server.setRequestHandler(GetPromptRequestSchema, async request => {
    const entry = (await withRuntimeLease('mcp-prompt:fla-menu', read)).find(item => item.name === request.params.name);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, `No FLA in the /fla menu is called ${request.params.name}`);
    return { description: entry.description, messages: [{ role: 'user', content: { type: 'text', text: entry.text } }] };
  });

  let tick = 0;
  let checking = false;
  const timer = setInterval(async () => {
    if (shown === null || checking) return;
    if (!server.isConnected()) { clearInterval(timer); return; }
    tick += 1;
    if (JSON.stringify(settings()) === seenSettings && tick % rosterEvery) return;
    checking = true;
    try {
      const previous = shown;
      remember(await read());
      if (shown !== previous) await server.server.sendPromptListChanged();
    } catch (error) { onError(error); }
    finally { checking = false; }
  }, settingsEveryMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
