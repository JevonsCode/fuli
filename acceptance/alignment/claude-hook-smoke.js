#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectClaudeCode } from '../../src/setup/claude-code-config.js';

const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(directory, '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'fuli-hook-smoke-'));
const workspace = join(temporaryRoot, 'hotel-b');
const mcpConfigPath = join(temporaryRoot, 'claude-mcp.json');
const settingsPath = join(temporaryRoot, 'claude-settings.json');
const auditPath = join(temporaryRoot, 'hook-audit.jsonl');
const resultsDirectory = join(directory, 'results');
const resultPath = join(resultsDirectory, 'hook-smoke-latest.json');

try {
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, 'package.json'),
    '{"name":"synthetic-hook-smoke","private":true}\n',
    'utf8'
  );
  writeFileSync(mcpConfigPath, '{"mcpServers":{}}\n', { mode: 0o600 });
  writeFileSync(settingsPath, '{}\n', { mode: 0o600 });
  connectClaudeCode({
    id: 'claude-code',
    label: 'Claude Code',
    configPath: mcpConfigPath,
    settingsPath
  }, {
    nodePath: process.execPath,
    mcpServerPath: join(directory, 'hook-smoke-mcp.js'),
    runtimeConfigPath: join(temporaryRoot, 'unused-runtime.json')
  });
  const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  mcpConfig.mcpServers.fuli.env = {
    FULI_ACCEPTANCE_LIFECYCLE_AUDIT_PATH: auditPath
  };
  writeFileSync(
    mcpConfigPath,
    `${JSON.stringify(mcpConfig, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );

  const result = await runClaude(workspace, mcpConfigPath, settingsPath);
  const auditEvents = readAuditEvents(auditPath);
  const summary = summarize(result, auditEvents);
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.pass) process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

async function runClaude(cwd, mcpConfig, settings) {
  const prompt = [
    'This is an isolated synthetic hook protocol smoke test.',
    'Call search_current_project_knowledge with projectPath equal to the current directory',
    'and queries=["synthetic hook context"]. Your final response must contain',
    'the exact marker HOOK-CONTEXT-731 returned by that tool.',
    'Then use the taskContextToken supplied by the entry hook to call',
    'checkpoint_task_knowledge with disposition=retain_nothing.',
    'Do not guess and do not call any other tool.'
  ].join('\n');
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--model', process.env.FULI_ALIGNMENT_CLAUDE_MODEL ?? 'sonnet',
    '--effort', 'low',
    '--max-budget-usd', '0.20',
    '--permission-mode', 'dontAsk',
    '--no-chrome',
    '--disable-slash-commands',
    '--settings', settings,
    '--include-hook-events',
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--tools', '',
    '--allowedTools',
    'mcp__fuli__search_current_project_knowledge,mcp__fuli__checkpoint_task_knowledge'
  ];
  return run('claude', args, { cwd, timeoutMs: 120_000 });
}

function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolvePromise({
        code,
        timedOut,
        stdout,
        stderr: stderr.slice(-800)
      });
    });
  });
}

function summarize({ code, timedOut, stdout, stderr }, auditEvents) {
  const events = stdout.split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const toolCalls = events
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.name);
  const result = events.findLast((event) => event.type === 'result');
  const answer = typeof result?.result === 'string' ? result.result : '';
  const signals = {
    entryHook: auditEvents.includes('begin_task_context'),
    stopHook: auditEvents.includes('verify_task_checkpoint'),
    searched: toolCalls.includes('mcp__fuli__search_current_project_knowledge'),
    checkpointed: toolCalls.includes('mcp__fuli__checkpoint_task_knowledge'),
    markerReturned: answer.includes('HOOK-CONTEXT-731')
  };
  const lifecyclePass = code === 0
    && !timedOut
    && !result?.is_error
    && signals.entryHook
    && signals.stopHook
    && signals.searched
    && signals.checkpointed;
  return {
    pass: lifecyclePass && signals.markerReturned,
    lifecyclePass,
    retrievalAnswerPass: signals.markerReturned,
    exitCode: code,
    timedOut,
    signals,
    toolCalls,
    auditEvents,
    error: stderr
      ? stderr
        .replaceAll(repositoryRoot, '<repository>')
        .replaceAll(temporaryRoot, '<temporary>')
      : null,
    rawTranscriptPersisted: false,
    dataClassification: 'synthetic_hook_protocol_smoke'
  };
}

function readAuditEvents(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return typeof value.event === 'string' ? [value.event] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
