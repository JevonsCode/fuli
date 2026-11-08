import { flaMenuEntries, menuLanguage, occupationNameMap } from './fla-menu.js';
import { menuCandidates } from './task-entry-named-fla.js';

// What a client's /fla menu lists now (fla-menu.js), read from the person's
// roster, nameable projects and occupation catalog: MCP prompts
// (src/mcp/fla-menu-prompts.js) and Codex prompt files
// (src/agents/codex/fla-prompts.js) both show this list.

// Whether the menu is on and its language (device settings, flaSlashMenu and
// consoleLanguage). Unreadable settings keep the default: on.
export function flaMenuSettings(application) {
  try { return application.flaMenuSettings?.() ?? { enabled: true, language: '' }; }
  catch { return { enabled: true, language: '' }; }
}

// The entries this client shows, or none while the setting is off.
export async function readFlaMenuEntries(application, sourceApplication) {
  const { enabled, language } = flaMenuSettings(application);
  if (!enabled) return [];
  const [candidates, catalog] = await Promise.all([menuCandidates(application),
    application.personal.occupationCatalog('list', { personal_space_id: application.config.personal.spaceId })
      .catch(() => null)]);
  return flaMenuEntries(candidates, { sourceApplication, language: menuLanguage(language),
    occupationNames: occupationNameMap(catalog) });
}
