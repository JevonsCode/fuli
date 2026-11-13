#!/usr/bin/env node
// The installed Codex lifecycle hook (pack-manifest.js runs it on every
// prompt, Stop, SessionStart and PreCompact). It hands the call to the running
// FULI console and runs it in this process only when the console cannot take
// it (lifecycle-forwarder.js); the work itself is lifecycle-event.js. Only
// Node built-ins load before that decision.
import { runThinLifecycleHook } from '../lifecycle-forwarder.js';
import { CODEX_HOOK_ENV, codexHookTimeoutMs } from './hook-contract.js';

await runThinLifecycleHook({ client: 'codex', envNames: CODEX_HOOK_ENV,
  timeoutMs: codexHookTimeoutMs(process.argv.slice(2)) });
