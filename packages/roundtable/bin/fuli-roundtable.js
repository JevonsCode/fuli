#!/usr/bin/env node
import { runCli } from '../src/standalone/cli.js';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
