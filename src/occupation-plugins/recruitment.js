import { InvalidInputError } from '../app/application-error.js';

// Bole and occupation kits: a recruitment waiting for a decision names the
// kit of each occupation it would hire, so the recruiting Agent shows it and
// asks the person once which recommended Skills and MCP servers to enable;
// their answer rides on the approval and is recorded for the new FLA.

// Names and ids only; the kit itself is read with read_occupation_kit.
export function recruitmentKitHint(application, personalSpaceId, occupations) {
  if (!application.occupationPlugins) return null;
  const kits = [...new Set(occupations.filter(Boolean))]
    .map(occupation => application.occupationPlugins.kit({ personalSpaceId, occupation }))
    .filter(kit => kit.plugin)
    .map(kit => ({ occupation: kit.occupation, plugin: `${kit.plugin.id}@${kit.plugin.version}`,
      skills: kit.skills.map(item => item.id), mcpServers: kit.mcpServers.map(item => item.id) }));
  return kits.length ? {
    kits,
    ask: 'Show the person each kit (read_occupation_kit with occupation) and ask once which recommended Skills and MCP servers the new FLA uses; pass their answer as occupationKit in decide_project_agent_recruitment. MCP servers are suggestions FULI never connects.'
  } : null;
}

// After an approval: the person's answer for the recruited FLA. A kit answer
// that does not fit leaves the approval as it is and says why.
export function recordRecruitmentKitAnswer(application, input, record) {
  if (!input.occupationKit || input.decision !== 'approve' || !record.recruitedAgentId) return null;
  const occupation = record.occupation?.role ?? null;
  if (!application.occupationPlugins || !occupation) return { status: 'not_recorded', reason: 'no occupation kit for this recruitment' };
  try {
    const kit = application.occupationPlugins.choose({ personalSpaceId: input.personalSpaceId, agentId: record.recruitedAgentId,
      occupation, skills: input.occupationKit.skills, mcpServers: input.occupationKit.mcpServers, answeredBy: 'recruitment' });
    return { status: 'recorded', plugin: `${kit.plugin.id}@${kit.plugin.version}`,
      skills: kit.skills.filter(item => item.enabled).map(item => item.id),
      mcpServers: kit.mcpServers.filter(item => item.enabled).map(item => item.id) };
  } catch (error) {
    if (error instanceof InvalidInputError) return { status: 'not_recorded', reason: error.message };
    throw error;
  }
}
