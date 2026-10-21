const REVIEW_SKILL_NAME = 'flreview';
// The person's /fuli start|stop|restart|status (rec#5 C3b). The prompt hook
// answers the line; the Skill only gives the client a /fuli command to accept.
const SESSION_COMMAND_SKILL_NAME = 'fuli';

// Keep every host-specific difference for the command Skills here. The shared
// SKILL.md files intentionally contain no Codex/Claude/Cursor branching.
// sessionCommand: whether the client turns an installed Skill into a /name
// command the person can type. Codex accepts no user-defined slash command
// (its TUI rejects an unknown one before any hook runs), so there the person
// types `fuli stop` without the slash and no Skill is installed. For the same
// reason the review is typed `fuli review` there (rec#22): the Codex prompt
// hook names the installed `flreview` Skill for that exact line.
const ADAPTERS = Object.freeze({
  codex: Object.freeze({
    root: ['.agents', 'skills'],
    userCommand: 'fuli review',
    nativeInvocation: '$flreview',
    sessionCommand: false
  }),
  'claude-code': Object.freeze({
    root: ['.claude', 'skills'],
    userCommand: '/flreview',
    nativeInvocation: '/flreview',
    sessionCommand: true
  }),
  cursor: Object.freeze({
    root: ['.cursor', 'skills'],
    userCommand: '/flreview',
    nativeInvocation: '/flreview',
    sessionCommand: true
  })
});

export function adaptAgentForCommandSkills(agent, { homeDir, pathApi }) {
  const adapter = adapterFor(agent.id);
  return {
    ...agent,
    reviewSkillPath: pathApi.join(homeDir, ...adapter.root, REVIEW_SKILL_NAME),
    reviewSkillTrigger: reviewSkillTrigger(agent.id),
    ...(adapter.sessionCommand
      ? { sessionCommandSkillPath: pathApi.join(homeDir, ...adapter.root, SESSION_COMMAND_SKILL_NAME) } : {})
  };
}

export function reviewSkillTrigger(agentId) {
  const adapter = adapterFor(agentId);
  return {
    userCommand: adapter.userCommand,
    nativeInvocation: adapter.nativeInvocation
  };
}

function adapterFor(agentId) {
  const adapter = ADAPTERS[agentId];
  if (!adapter) throw new TypeError(`Unsupported command Skill agent: ${agentId}`);
  return adapter;
}
