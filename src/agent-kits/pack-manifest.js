// A client descriptor pack's part of FULI's product manifest for
// agent-installer (rec#11 D-79, D-10): what FULI installs into that client,
// read from the pack the person has active (client-pack-store.js), so a
// trusted pack update changes what agent-installer writes. The pack's
// `configWriter` names how its data maps onto the manifest; `{placeholders}`
// stay for the installer's variables (installer-manifest.js).

// The packaged Skills every pack client receives, and the person's
// /fuli start|stop|restart|status (rec#5 C3b) where the client turns a Skill
// into a command (`commandSkills.sessionCommand`).
const SKILLS = Object.freeze(['capturing-session-knowledge', 'grilling-project', 'operating-fuli']);
const SESSION_COMMAND_SKILL = 'fuli';
// The tool profile a new entry starts with; the person's own choice in an
// existing entry survives (the manifest's `preserveArgs`).
const CHAT_PROFILE = Object.freeze(['--tool-profile', 'chat']);
const CODEX_INSTRUCTION_MARKERS = Object.freeze({
  begin: '<!-- BEGIN FULI MANAGED INSTRUCTIONS -->',
  end: '<!-- END FULI MANAGED INSTRUCTIONS -->'
});
// Claude Code and Codex name their events as the installer's keys, capitalized.
const capitalizedEvent = (event) => `${event[0].toLowerCase()}${event.slice(1)}`;
const CURSOR_EVENTS = Object.freeze({ sessionStart: 'sessionStart', beforeSubmitPrompt: 'userPromptSubmit', stop: 'stop' });
// Claude Code's hook gives itself two seconds less than the client waits.
const claudeHookTimeoutMs = (timeoutSec) => String(Math.max(100, timeoutSec * 1000 - 2000));

const SECTIONS = Object.freeze({
  'claude-code-settings': (pack) => ({
    mcp: mcpOf(pack, CHAT_PROFILE),
    hooks: hooksOf(pack, ['--fuli-'], capitalizedEvent, ({ event, statusMessage }) => ({
      command: ['{nodePath}', '{claudeHook}', '--fuli-claude-lifecycle', '--runtime-config', '{runtimeConfigPath}',
        '--event', event, '--timeout-ms', claudeHookTimeoutMs(pack.lifecycleHooks.timeoutSec)],
      timeoutSec: pack.lifecycleHooks.timeoutSec, statusMessage })),
    permissions: { allow: [...pack.permissions.allow] },
    skills: skillsOf(pack)
  }),
  'codex-toml': (pack) => ({
    mcp: mcpOf(pack, CHAT_PROFILE),
    hooks: hooksOf(pack, ['--fuli-lifecycle'], capitalizedEvent, ({ event }) => ({
      command: lifecycleCommand('{codexHook}', event), timeoutSec: pack.lifecycleHooks.timeoutSec })),
    instructions: { markdown: pack.instructions.global.join('\n'), ...CODEX_INSTRUCTION_MARKERS },
    skills: skillsOf(pack)
  }),
  // Cursor names a tool profile only when the person chose one.
  'cursor-hooks': (pack) => ({
    mcp: mcpOf(pack, []),
    hooks: hooksOf(pack, ['--fuli-lifecycle'], (event) => CURSOR_EVENTS[event], ({ event, loopLimit }) => ({
      command: lifecycleCommand('{cursorHook}', event), timeoutSec: pack.lifecycleHooks.timeoutSec,
      ...(loopLimit === undefined ? {} : { extra: { loop_limit: loopLimit } }) })),
    skills: skillsOf(pack)
  }),
  // OpenCode runs FULI's lifecycle as a plugin (installer-manifest.js adds it
  // for OpenCode 2.x), not as hook commands.
  'opencode-plugin': (pack) => ({ mcp: mcpOf(pack, CHAT_PROFILE), skills: skillsOf(pack) })
});

export function packManifestClient(pack) {
  const section = SECTIONS[pack.configWriter];
  if (!section) throw new TypeError(`Unknown client config writer: ${pack.configWriter}`);
  return section(pack);
}

// The pack's MCP entry: its arguments with the tool profile filled in, and
// its other settings as the client's extra fields. The command is the
// manifest's `{nodePath}`; the transport `type` is the installer's to write.
function mcpOf(pack, profileArgs) {
  const { command: _command, args, type: _type, ...extra } = pack.mcpServer;
  return { args: args.flatMap((arg) => (arg === '{toolProfileArgs}' ? profileArgs : [arg])),
    ...(Object.keys(extra).length ? { extra } : {}) };
}

function hooksOf(pack, markers, eventKey, handler) {
  return { markers, events: Object.fromEntries(pack.lifecycleHooks.events.map((item) => [eventKey(item.event), handler(item)])) };
}

function lifecycleCommand(script, event) {
  return ['{nodePath}', script, '--fuli-lifecycle', '--runtime-config', '{runtimeConfigPath}', '--event', event];
}

function skillsOf(pack) {
  return [...SKILLS, ...(pack.commandSkills.sessionCommand ? [SESSION_COMMAND_SKILL] : [])].map((name) => ({
    name, source: `{skillsDir}/${name}`, adopt: { file: 'SKILL.md', contains: `name: ${name}` } }));
}
