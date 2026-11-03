// What FULI installs into a client for one data directory: the MCP server,
// its runtime configuration and the packaged Skills. agent-installer installs
// it from FULI's product manifest (src/agent-kits/installer-manifest.js).
export function integrationContext(paths, runtimeConfigPath = paths.graphRuntimeConfigPath) {
  return {
    dataDir: paths.dataDir,
    nodePath: paths.clientNodePath,
    mcpServerPath: paths.mcpServerPath,
    runtimeConfigPath,
    skillsDir: paths.skillsDir
  };
}
