// Two ways to run one arm, with the same task and the same one selected
// workflow:
// - deterministic: a built-in data stand-in. It is a CI seam, not a model and
//   not evidence about a live client; results say so.
// - opencode: a real OpenCode v2 process in a fresh temporary workspace and a
//   fresh isolated home. The selected stored workflow is written as exactly one
//   native Skill; only the `skill` tool is available, its permission is limited
//   to that Skill's id, and no MCP server or plugin is configured. The client
//   cannot write files: it returns a JSON artifact map and the trusted grader
//   writes it inside the temporary workspace.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { parseModelJson } from '../../src/text/model-json.js';
import { writeArtifactFiles } from './artifacts.js';
import { skillMarkdown, skillSlug } from './skill.js';

const OUTPUT_LIMIT = 256 * 1024;
const MAX_PROVIDER_CONFIG_BYTES = 1024 * 1024;
const MAX_TOOL_CALLS = 50;
const MAX_STEPS = 200;
const MAX_TOKEN_FIELD = 1_000_000_000;
const MAX_TOKEN_TOTAL = 1_000_000_000_000;

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/u)[0] || null;
}

function unavailable(command, detail) {
  return Object.assign(new Error(detail), { code: 'client_unavailable' });
}

function assertNativeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('--client-command needs a command');
  if (/\.(?:cmd|bat)$/iu.test(command)) {
    throw new TypeError(`The client command ${command} is a shell wrapper; it is not supported because argv would pass through a shell. `
      + 'Pass the native OpenCode executable (for example opencode.exe or the native opencode binary) instead.');
  }
}

function probe(command, timeoutMs) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false });
  if (result.error?.code === 'ENOENT') throw unavailable(command, `The client command ${command} was not found; no live arm was run`);
  return {
    version: result.status === 0 ? firstLine(result.stdout) : null,
    ...(result.status === 0 ? {} : { versionError: firstLine(result.stderr) ?? (result.error?.message ?? 'unknown') })
  };
}

function requireOpenCodeV2(command, timeoutMs) {
  const found = probe(command, timeoutMs);
  if (!found.version) throw unavailable(command, `Could not read the OpenCode version from ${command}: ${found.versionError ?? 'no output'}`);
  if (!/^opencode\s+v?2\./iu.test(found.version)) {
    throw unavailable(command, `OpenCode v2 is required; ${command} reported ${found.version}`);
  }
  return found.version;
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => current.length >= OUTPUT_LIMIT ? current
      : current + chunk.toString('utf8').slice(0, OUTPUT_LIMIT - current.length);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    let timer;
    child.on('error', error => {
      clearTimeout(timer);
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        reject(Object.assign(new Error(`The client command ${command} could not be started: ${error.message}`),
          { code: 'client_unavailable' }));
        return;
      }
      reject(error);
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
  });
}

function readProviderConfig(path, providerName, model) {
  if (!path) throw new TypeError('--provider-config <file> is required with --mode opencode');
  let stat;
  try { stat = statSync(path); } catch (error) { throw new TypeError(`Cannot read --provider-config ${path}: ${error.message}`); }
  if (!stat.isFile()) throw new TypeError(`--provider-config ${path} is not a regular file`);
  if (stat.size > MAX_PROVIDER_CONFIG_BYTES) throw new TypeError(`--provider-config ${path} is larger than ${MAX_PROVIDER_CONFIG_BYTES} bytes`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    throw new TypeError(`--provider-config ${path} is not valid JSON: ${error.message}`);
  }
  const provider = parsed?.provider?.[providerName];
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError(`--provider-config ${path} has no provider "${providerName}" for model ${model}`);
  }
  const copy = JSON.parse(JSON.stringify(provider));
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > MAX_PROVIDER_CONFIG_BYTES) {
    throw new TypeError(`Provider "${providerName}" is too large to copy into an isolated config`);
  }
  return copy;
}

function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), 'fuli-oc-home-'));
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
  return home;
}

function isolatedEnv(home, workspace) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key];
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_CACHE_HOME = join(home, '.cache');
  env.XDG_STATE_HOME = join(home, '.local', 'state');
  env.NO_COLOR = '1';
  // OpenCode resolves its project directory from PWD rather than from the
  // process working directory it inherits. Leaving the parent's PWD here would
  // make an arm read another project's config (and so miss the temporary one);
  // point PWD at the workspace the arm was actually started in.
  env.PWD = workspace;
  delete env.OLDPWD;
  return env;
}

function opencodeConfig({ model, provider, selectedSkill }) {
  const providerName = model.slice(0, model.indexOf('/'));
  return {
    $schema: 'https://opencode.ai/config.json',
    model,
    snapshot: false,
    snapshots: false,
    share: 'disabled',
    autoupdate: false,
    instructions: [],
    mcp: {},
    plugin: [],
    plugins: [],
    provider: { [providerName]: provider },
    tools: { '*': false, skill: Boolean(selectedSkill) },
    permission: { '*': 'deny', skill: selectedSkill ? { '*': 'deny', [selectedSkill]: 'allow' } : { '*': 'deny' } }
  };
}

function livePrompt(task, files) {
  const rendered = Object.entries(files).map(([path, content]) => `--- ${path} ---\n${content}`).join('\n');
  return `${task.prompt}\n\n`
    + 'The repository is text-only and you cannot read it with tools. Current files:\n\n'
    + `${rendered}\n\n`
    + 'Output protocol: do not create files with tools. Return exactly one JSON object and no other text: '
    + '{"files":{"<relative path>":"<complete file content>"},"notes":"<optional>"}. '
    + 'Paths must be relative to the repository root and every file must be complete.';
}

// The event parser and evidence summarizer are pure: they take the JSONL the
// client printed and return bounded values. Exported so tests can feed native
// event lines directly on any platform, including Windows where shebang
// fixtures cannot run.
export function parseEventStream(stdout) {
  const texts = [];
  const tools = [];
  const errors = [];
  const steps = [];
  const models = new Set();
  let events = 0;
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    events += 1;
    if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') texts.push(event.part.text);
    if (event.type === 'tool_use' && event.part?.tool) {
      const state = event.part.state ?? {};
      tools.push({ id: event.part.id ?? event.part.partID ?? null, tool: event.part.tool,
        status: state.status ?? null, inputId: state.input?.id ?? null, error: state.error ?? null });
    }
    if (event.type === 'error') errors.push(event.error?.message ?? String(event.error ?? 'client error'));
    if (event.type === 'step_finish' && steps.length < MAX_STEPS) {
      steps.push({
        input: event.part?.tokens?.input,
        output: event.part?.tokens?.output,
        reasoning: event.part?.tokens?.reasoning,
        cacheRead: event.part?.tokens?.cache?.read,
        cacheWrite: event.part?.tokens?.cache?.write
      });
      const reported = reportedModel(event);
      if (reported) models.add(reported);
    }
  }
  const unique = [...new Map(tools.map(call => [call.id, call])).values()];
  return {
    transcriptCaptured: events > 0,
    text: texts.join(''),
    toolCalls: unique.slice(0, MAX_TOOL_CALLS),
    errors,
    steps,
    reportedModels: [...models]
  };
}

// Step events may name the provider and model that actually answered. Keep it
// only when it is a plain reported value, never derived from the request.
function reportedModel(event) {
  const part = event.part ?? {};
  const provider = typeof part.providerID === 'string' ? part.providerID : null;
  const model = typeof part.modelID === 'string' ? part.modelID : null;
  if (provider && model) return `${provider}/${model}`;
  if (model) return model;
  return null;
}

function tokenField(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_FIELD ? value : null;
}

// Sum only what the client reported in step_finish events. A missing or
// implausible field stays unknown instead of being estimated or clamped, and a
// total that passes the safe bound becomes unknown too.
function aggregateTokens(steps) {
  if (!steps.length) {
    return { source: 'unknown', steps: 0, input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null,
      unavailable: 'The client reported no step_finish token events for this arm.' };
  }
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const known = { input: true, output: true, reasoning: true, cacheRead: true, cacheWrite: true };
  for (const step of steps) {
    for (const name of Object.keys(totals)) {
      if (!known[name]) continue;
      const value = tokenField(step[name]);
      if (value === null) { known[name] = false; continue; }
      totals[name] += value;
      if (totals[name] > MAX_TOKEN_TOTAL) known[name] = false;
    }
  }
  const read = Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, known[name] ? value : null]));
  return { source: 'client-reported', steps: steps.length, ...read };
}

function parseArtifacts(text) {
  let value;
  try { value = parseModelJson(text); } catch (error) { return { error: `The live client did not return a JSON artifact object: ${error.message}` }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'The live client artifact answer is not an object' };
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    return { error: 'The live client artifact answer has no files object' };
  }
  return {
    files: value.files,
    notes: typeof value.notes === 'string' ? value.notes.slice(0, 2000) : null
  };
}

export function summarizeEvidence({ selection = null, selectedSkill = null, stream, model = null }) {
  const calls = stream.toolCalls ?? [];
  const skillCalls = calls.filter(call => call.tool === 'skill');
  const readCall = skillCalls.find(call => call.status !== 'error' && call.inputId === selectedSkill);
  // A failed attempt at some other skill name is not a failure of this arm; only
  // fail closed when the selected Skill itself could not be read.
  const errorCall = readCall ? null : skillCalls.find(call => call.status === 'error');
  const reportedModels = stream.reportedModels ?? [];
  const tokens = aggregateTokens(stream.steps ?? []);
  return {
    transcript: 'opencode-json-events',
    transcriptCaptured: stream.transcriptCaptured,
    providerContact: true,
    // "Contact" means this isolated client was configured to send a model
    // request. Only a finished model step shows that upstream execution really
    // happened, so the two are recorded separately.
    upstreamExecution: tokens.steps > 0 ? 'confirmed' : stream.transcriptCaptured ? 'not_confirmed' : 'unknown',
    requestedModel: model,
    reportedModel: reportedModels.length === 1 ? reportedModels[0] : null,
    reportedModelSource: reportedModels.length === 1 ? 'step_events' : 'unknown',
    ...(reportedModels.length > 1 ? { reportedModelUnavailable: 'Step events named more than one model.' } : {}),
    tokens,
    toolCalls: calls.map(call => ({ tool: call.tool, status: call.status, inputId: call.inputId, ...(call.error ? { error: call.error } : {}) })),
    skillRead: Boolean(readCall),
    skillReadExpected: Boolean(selection),
    skillCallStatus: errorCall ? 'error' : readCall ? 'completed' : 'not_called',
    ...(errorCall?.error ? { skillError: String(errorCall.error) } : {}),
    ...((stream.errors ?? []).length ? { clientErrors: stream.errors } : {})
  };
}

// The deterministic stand-in writes the scenario's declared files. It never
// reads a live client, a model or an external service.
function runDeterministic({ task, selection, workspace }) {
  const files = task.kind === 'negative' ? task.standIn?.files
    : selection ? task.standIn?.onFiles : task.standIn?.offFiles;
  if (!files) {
    return { stdout: '', stderr: 'The scenario has no deterministic stand-in for this task. '
      + 'Use --mode opencode for a live run.', exitCode: 2, timedOut: false };
  }
  try {
    const { written, bytes } = writeArtifactFiles(workspace, files, { label: 'stand-in files' });
    return { stdout: `wrote ${written.join(', ')}\n`, stderr: '', exitCode: 0, timedOut: false,
      evidence: { transcript: null, transcriptCaptured: false, providerContact: false, upstreamExecution: 'not_applicable',
        requestedModel: null, reportedModel: null, reportedModelSource: 'not_applicable',
        tokens: { source: 'not_applicable', steps: 0, input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
        toolCalls: [], skillRead: null, skillReadExpected: Boolean(selection), skillCallStatus: 'not_applicable', bytes } };
  } catch (error) {
    return { stdout: '', stderr: error.message, exitCode: 2, timedOut: false };
  }
}

async function runOpencode({ task, selection, workspace, files, command, model, provider, timeoutMs }) {
  const home = isolatedHome();
  try {
    const slug = selection ? skillSlug(selection.name) : null;
    if (selection) {
      const directory = join(workspace, '.opencode', 'skills', slug);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'SKILL.md'), skillMarkdown(selection));
    }
    writeFileSync(join(workspace, 'opencode.json'),
      `${JSON.stringify(opencodeConfig({ model, provider, selectedSkill: slug }), null, 2)}\n`, { mode: 0o600 });
    const started = await runProcess(command, ['run', '--standalone', '--format', 'json', '--model', model,
      livePrompt(task, files)], { cwd: workspace, env: isolatedEnv(home, workspace), timeoutMs });
    const stream = parseEventStream(started.stdout);
    const artifacts = stream.transcriptCaptured ? parseArtifacts(stream.text) : { error: 'The live client returned no JSON event transcript' };
    return {
      ...started,
      artifacts,
      evidence: { ...summarizeEvidence({ selection, selectedSkill: slug, stream, model }),
        artifactFiles: artifacts.error ? 0 : Object.keys(artifacts.files).length }
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// One client for both arms, so its identity, model and isolated config are the
// same. The deterministic client says in its own name that it is not a live client.
export function createClient({ mode, model = null, command = 'opencode', providerConfig = null,
  timeoutMs = 600_000 } = {}) {
  if (mode === 'deterministic') {
    return {
      identity: { name: 'deterministic-rule-follower', version: '1', evidenceKind: 'deterministic_seam', live: false,
        providerContact: false, isolation: { workspace: 'fresh temporary directory per arm' } },
      run: async args => runDeterministic(args)
    };
  }
  if (mode !== 'opencode') throw new TypeError(`Unknown mode ${mode}; use deterministic or opencode`);
  if (!model || !/^[^/\s]+\/\S+$/u.test(model)) throw new TypeError('--model provider/model is required with --mode opencode');
  assertNativeCommand(command);
  const providerName = model.slice(0, model.indexOf('/'));
  const provider = readProviderConfig(providerConfig, providerName, model);
  const version = requireOpenCodeV2(command, Math.min(timeoutMs, 30_000));
  return {
    identity: { name: 'opencode', command: basename(command), version, evidenceKind: 'live_client', live: true, model,
      providerContact: true, isolation: { standalone: true, freshHomePerArm: true, mcpServers: 0, plugins: 0,
        toolsAllowed: ['skill'], skillPermission: 'the selected Skill id only' } },
    run: args => runOpencode({ ...args, command, model, provider, timeoutMs })
  };
}
