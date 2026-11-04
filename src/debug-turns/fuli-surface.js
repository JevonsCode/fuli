// FULI's MCP instructions and tool list as a client receives them from the
// chat profile, the profile FULI's client setup installs (pack-manifest.js
// CHAT_PROFILE; a person may have switched an entry to full). Read through an
// in-memory MCP client, so it is exactly what initialize and tools/list
// answer; no FULI data is opened.
export async function fuliMcpSurface() {
  const [{ createMcpServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    import('../mcp/create-mcp-server.js'),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js')
  ]);
  const server = createMcpServer({}, { env: {}, toolProfile: 'chat', registerResources: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fuli-debug-turn', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    return { instructions: client.getInstructions() ?? '', tools };
  } finally {
    await client.close();
    await server.close();
  }
}
