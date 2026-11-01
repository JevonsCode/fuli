// What `fuli setup` installs into a client for one data directory: the MCP
// server, its runtime configuration and the packaged Skills. FULI's writers
// install it, and agent-installer is asked whether each client has it.
export function integrationContext(paths, runtimeConfigPath = paths.graphRuntimeConfigPath) {
  return {
    dataDir: paths.dataDir,
    nodePath: paths.clientNodePath,
    mcpServerPath: paths.mcpServerPath,
    runtimeConfigPath,
    sessionSkillPath: paths.sessionSkillPath,
    projectSkillPath: paths.projectSkillPath,
    reviewSkillPath: paths.reviewSkillPath,
    operationSkillPath: paths.operationSkillPath,
    sessionCommandSkillPath: paths.sessionCommandSkillPath
  };
}
