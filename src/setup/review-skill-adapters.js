const REVIEW_SKILL_NAME = 'flreview';

// Keep every host-specific difference for the review Skill here. The shared
// SKILL.md intentionally contains no Codex/Claude/Cursor branching.
const ADAPTERS = Object.freeze({
  codex: Object.freeze({
    root: ['.agents', 'skills'],
    nativeInvocation: '$flreview',
    needsCommandBridge: true
  }),
  'claude-code': Object.freeze({
    root: ['.claude', 'skills'],
    nativeInvocation: '/flreview',
    needsCommandBridge: false
  }),
  cursor: Object.freeze({
    root: ['.cursor', 'skills'],
    nativeInvocation: '/flreview',
    needsCommandBridge: false
  })
});

export function adaptAgentForReviewSkill(agent, { homeDir, pathApi }) {
  const adapter = adapterFor(agent.id);
  return {
    ...agent,
    reviewSkillPath: pathApi.join(homeDir, ...adapter.root, REVIEW_SKILL_NAME),
    reviewSkillTrigger: reviewSkillTrigger(agent.id)
  };
}

export function reviewSkillTrigger(agentId) {
  const adapter = adapterFor(agentId);
  return {
    userCommand: '/flreview',
    nativeInvocation: adapter.nativeInvocation,
    needsCommandBridge: adapter.needsCommandBridge
  };
}

export function codexReviewCommandBridge() {
  return 'Exact `/flreview`: load installed `flreview` Skill.';
}

function adapterFor(agentId) {
  const adapter = ADAPTERS[agentId];
  if (!adapter) throw new TypeError(`Unsupported review Skill agent: ${agentId}`);
  return adapter;
}
