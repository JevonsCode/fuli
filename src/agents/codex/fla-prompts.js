import { utf8Preview } from '../../text/utf8-preview.js';

// The /fla menu in the Codex app (11-08). The app shows no MCP prompts, but
// lists `<CODEX_HOME>/prompts/*.md` in its / menu as `prompts:<name>` with
// the file's description, reading the folder when a window starts. A pick
// sends the file's body, a newline and what the person typed:
// `#FLA <name>\n<request>`, which task entry resolves like a typed #FLA.
//
// FULI writes only through agent-installer (its `prompts` component): this
// keeps the list the installer manifest gives Codex, and re-applies Codex
// when the list changes. The installer writes each file with FULI's
// ownership line, removes the ones FULI no longer lists, skips a name the
// person's own prompt already has, and deletes FULI's when Codex is
// disconnected. Until the first read the list is unknown and the manifest
// says nothing, so no other caller of the installer changes the files.

const CHECK_EVERY_MS = 60_000;
// A Codex FULI is not connected to, or one whose other FULI parts the person
// changed, is looked at again after this long.
const RETRY_DISCONNECTED_MS = 10 * 60_000;
// agent-installer 0.4 refuses a whole manifest with more than 256 prompts,
// and every client's status, install and repair with it; FULI stays well below.
const PROMPT_LIMIT = 200;
// Its description limit, in UTF-16 code units as it counts them.
const DESCRIPTION_LIMIT = 256;

// Menu entries (fla-menu.js) as agent-installer prompts: every built-in
// role, then the FLAs Codex may continue, most recent first, up to the limit.
export function codexPromptFiles(entries) {
  const roles = entries.filter(entry => entry.role);
  const flas = entries.filter(entry => !entry.role).slice(0, Math.max(0, PROMPT_LIMIT - roles.length));
  return [...flas, ...roles].map(entry => ({ name: entry.name,
    description: utf8Preview(entry.description, DESCRIPTION_LIMIT, text => text.length), body: entry.text }));
}

// read(): the menu entries for Codex now (fla-menu-reader.js); [] when off.
export function createCodexFlaPromptSync({ read, everyMs = CHECK_EVERY_MS, retryDisconnectedMs = RETRY_DISCONNECTED_MS,
  now = Date.now, onError = warnOnce() }) {
  let current = null;
  let applied = null;
  let notBefore = 0;

  // installer: the client installer port (client-installer.js). True when
  // this list is now Codex's; a list not yet applied is tried again.
  async function sync(installer) {
    const wanted = codexPromptFiles(await read());
    const digest = JSON.stringify([...wanted].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
    if (digest === applied) return false;
    current = wanted;
    if (now() < notBefore) return false;
    const status = await installer.status();
    if (status.status !== 'available') return false;
    const codex = status.clients.find(client => client.id === 'codex');
    // Connecting Codex later writes this list with everything else; FULI's
    // other Codex parts the person changed are left for the doctor or a
    // reconnect. agent-installer's ClientStatus: `componentStates` holds
    // each part's state (`components` only names the parts).
    const others = (codex?.componentStates ?? []).filter(item => item.component !== 'prompts');
    if (!codex || !['connected', 'update_available'].includes(codex.state)
      || !others.every(item => ['current', 'unsupported'].includes(item.state))) {
      notBefore = now() + retryDisconnectedMs;
      return false;
    }
    const result = await installer.apply(['codex']);
    const written = result?.status === 'available' && !result.problems?.some(problem => problem.client === 'codex');
    if (written) { applied = digest; notBefore = 0; }
    return written;
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

// A failed check is said in the console's log once, not every minute; a
// different failure is said again.
function warnOnce(log = message => console.warn(message)) {
  let last = null;
  return error => {
    const message = `The Codex /fla prompt files were not updated: ${error?.message ?? error}`;
    if (message !== last) log(message);
    last = message;
  };
}
