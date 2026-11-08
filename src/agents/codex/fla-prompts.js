// The /fla menu in the Codex app (11-08). The app shows no MCP prompts, but
// lists `<CODEX_HOME>/prompts/*.md` in its / menu as `prompts:<name>` with
// the file's description, reading the folder when a window starts. A pick
// sends the file's body, a newline and what the person typed:
// `#FLA <name>\n<request>`, which task entry resolves like a typed #FLA.
//
// FULI writes only through agent-installer (its `prompts` component): this
// keeps the list the installer manifest gives Codex, and re-applies Codex
// when the list changes. The installer writes each file with FULI's
// ownership line, removes the ones FULI no longer lists, never touches the
// person's own prompts, and deletes FULI's when Codex is disconnected.
// Until the first read the list is unknown and the manifest says nothing,
// so no other caller of the installer changes the files.

const CHECK_EVERY_MS = 60_000;
const DESCRIPTION_LIMIT = 256;

// Menu entries (fla-menu.js) as agent-installer prompts.
export function codexPromptFiles(entries) {
  return entries.map(entry => ({ name: entry.name, description: [...entry.description].slice(0, DESCRIPTION_LIMIT).join(''),
    body: entry.text }));
}

// read(): the menu entries for Codex now (fla-menu-reader.js); [] when off.
export function createCodexFlaPromptSync({ read, everyMs = CHECK_EVERY_MS, onError = () => {} }) {
  let current = null;
  let applied = null;

  // installer: the client installer port (client-installer.js).
  async function sync(installer) {
    const wanted = codexPromptFiles(await read());
    const digest = JSON.stringify(wanted);
    if (digest === applied) return false;
    current = wanted;
    const status = await installer.status();
    if (status.status !== 'available') return false;
    const codex = status.clients.find(client => client.id === 'codex');
    const connected = codex && ['connected', 'update_available'].includes(codex.state);
    // A Codex FULI is not connected to, or whose other FULI parts the person
    // changed, is left as it is; connecting or repairing it writes this list.
    if (connected && !(codex.components ?? []).every(item => item.component === 'prompts' || item.state === 'current'
      || item.state === 'unsupported')) return false;
    if (connected) await installer.apply(['codex']);
    applied = digest;
    return connected;
  }

  return {
    // The list the installer manifest gives Codex, or null while unknown.
    prompts: () => current,
    sync,
    start(installer) {
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try { await sync(installer); } catch (error) { onError(error); } finally { running = false; }
      };
      const timer = setInterval(tick, everyMs);
      timer.unref?.();
      void tick();
      return () => clearInterval(timer);
    }
  };
}
