import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A plain constrained Claude Code run (a visit request's planning pass or its
// edit), not a session of any Agent: restricted mode, which removes the tools
// that run commands or code and WebFetch unless --tools names them, ignores
// the user, project and local settings files, confines the file tools to the
// working directory, refuses bypassPermissions and leaves writes to settings,
// Git and tool configuration to a person; only the named tools; and an empty
// strict MCP configuration, so no MCP server at all, FULI's included.
const EMPTY_MCP = JSON.stringify({ mcpServers: {} });
const READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
const EDIT_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit']);
const DENIED_TOOLS = Object.freeze(['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'NotebookEdit']);
const STEPS = Object.freeze({
  // Reads only, in the owner's project folder.
  plan: ['--permission-mode', 'dontAsk', '--tools', READ_TOOLS.join(','),
    '--disallowedTools', [...DENIED_TOOLS, 'Edit', 'Write', 'MultiEdit'].join(',')],
  // Reads and edits, in the request's worktree.
  edit: ['--permission-mode', 'acceptEdits', '--tools', EDIT_TOOLS.join(','), '--disallowedTools', DENIED_TOOLS.join(',')],
});
// What an older CLI says about the flag it does not know.
const UNKNOWN_RESTRICTED = /unknown option[^\n]*--restricted/i;

export const claudeCodeConstrainedRun = Object.freeze({
  id: 'claude_code',

  args(step) {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--restricted', ...STEPS[step],
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP];
  },

  // Restricted mode ignores the person's settings files, so the model access
  // they configured in the env block of their user settings (a base URL, a
  // model name) is passed to the child process's environment instead: only
  // string values, never on the command line, never logged or kept.
  // CLAUDE_CONFIG_DIR moves the settings folder as Claude Code itself does.
  environment({ env, home, readText = (path) => readFileSync(path, 'utf8') }) {
    try {
      const settings = JSON.parse(readText(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json')));
      const block = settings?.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
      return Object.fromEntries(Object.entries(block).filter(([key, value]) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)));
    } catch { return {}; }
  },

  // A CLI without restricted mode never runs the step unrestricted: the wake fails with its own detail.
  restrictedUnsupported: (stderr) => UNKNOWN_RESTRICTED.test(stderr),
});
