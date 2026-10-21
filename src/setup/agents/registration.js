// Whether a JSON client's FULI entry is present and runs the expected command
// and arguments. `expectedEntry` receives the installed entry, so an explicit
// tool profile the person chose is kept; a failure counts as outdated.
export function jsonRegistration(agent, readers, expectedEntry) {
  let present = false;
  try {
    const server = readers.readJson(agent.configPath)?.mcpServers?.fuli;
    present = Boolean(server && typeof server === 'object' && !Array.isArray(server));
    const expected = expectedEntry(server);
    return { present, current: present && server.command === expected.command &&
      JSON.stringify(server.args) === JSON.stringify(expected.args) };
  } catch { return { present, current: false }; }
}
