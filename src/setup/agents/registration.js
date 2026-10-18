import { installedToolProfile } from '../installed-tool-profile.js';

export function jsonRegistration(agent, context, readers, { source, profile, fixedProfile, optionalProfile } = {}) {
  let present = false;
  try {
    const server = readers.readJson(agent.configPath)?.mcpServers?.fuli;
    present = Boolean(server && typeof server === 'object' && !Array.isArray(server));
    const args = [context.mcpServerPath, '--runtime-config', context.runtimeConfigPath, '--source-application', source];
    if (profile || fixedProfile || (optionalProfile && server?.args?.includes('--tool-profile'))) args.push('--tool-profile', fixedProfile ?? installedToolProfile(server?.args, context.toolProfile));
    return { present, current: present && server.command === context.nodePath &&
      JSON.stringify(server.args) === JSON.stringify(args) };
  } catch { return { present, current: false }; }
}
