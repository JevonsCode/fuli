import { toolNamesForProfile } from '../mcp/tool-profiles.js';

// Missing profile in legacy setup meant full by accident; explicit choices
// survive managed upgrades. This reads only the already loaded client entry.
export function installedToolProfile(args, requestedProfile) {
  const index = Array.isArray(args) ? args.indexOf('--tool-profile') : -1;
  const profile = requestedProfile ?? (index >= 0 ? args[index + 1] : 'chat');
  if (typeof profile !== 'string' || !profile.trim()) throw new TypeError('Explicit MCP tool profile requires a value');
  toolNamesForProfile(profile);
  return profile;
}
