#!/usr/bin/env node
// The installed Claude Code lifecycle hook (pack-manifest.js runs it on every
// prompt, Stop, SessionStart and PreCompact). It hands the call to the running
// FULI console and runs it in this process only when the console cannot take
// it (lifecycle-forwarder.js); the work itself is lifecycle-event.js. Only
// Node built-ins load before that decision.
import { runThinLifecycleHook } from '../lifecycle-forwarder.js';
import { CLAUDE_HOOK_ENV, claudeHookTimeoutMs } from './hook-contract.js';

await runThinLifecycleHook({ client: 'claude-code', envNames: CLAUDE_HOOK_ENV,
  timeoutMs: claudeHookTimeoutMs(process.argv.slice(2)) });
