#!/usr/bin/env node
import { runMcpCommand, startupMessage } from './cli/mcp-command.js';

await runMcpCommand(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${startupMessage(error)}\n`);
  process.exitCode = 1;
});
