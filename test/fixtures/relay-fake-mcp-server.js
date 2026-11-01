import { createInterface } from 'node:readline';

// A stand-in stdio MCP server for stdio-relay tests. It answers with its own
// version (argv[2]); a version starting with "broken" exits at once, and the
// method "slow" answers after a moment.
const version = process.argv[2];
if (version.startsWith('broken')) process.exit(3);
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version } } });
  } else if (message.method === 'slow') {
    setTimeout(() => send({ id: message.id, result: { version } }), 300);
  } else {
    send({ id: message.id, result: { version } });
  }
});
process.stdin.once('end', () => process.exit(0));
