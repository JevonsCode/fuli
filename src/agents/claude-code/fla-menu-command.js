import { FLA_MENU_PREFIX } from '../../graphiti/fla-menu.js';

// Claude Code puts an MCP prompt chosen from its / menu into the prompt as
// `/mcp__<server>__<prompt> <text>` (shown in the menu as `/<server>:<prompt>`)
// and hands the prompt hook that line, not the prompt's expansion. A pick from
// FULI's /fla menu (src/mcp/fla-menu-prompts.js) becomes `#FLA <menu name>
// <text>`, which task entry resolves to exactly that FLA, like a typed #FLA.
// The server is `fuli`, or a plugin's namespaced copy of it.
const MENU_COMMAND = new RegExp(String.raw`^\/(?:mcp__[\w-]*?fuli__|fuli:)(${FLA_MENU_PREFIX}\S+)(?:\s+([\s\S]*))?$`, 'u');

export function claudeFlaMenuPrompt(prompt) {
  const pick = MENU_COMMAND.exec(prompt.trimStart());
  return pick ? `#FLA ${pick[1]}${pick[2]?.trim() ? ` ${pick[2].trim()}` : ''}` : prompt;
}
