#!/usr/bin/env node
// Does FULI make a project cheaper the more it is used? Runs the six-session Tidewater sequence (sessions.js) with
// headless Claude Code in two arms and records every session:
//   off  : no FULI. Each session starts with only the repo.
//   fuli : FULI's Claude Code hooks + MCP from --fuli-config, against an isolated FULI. One personal project per rep,
//          so FULI starts that rep knowing nothing about Tidewater and keeps what it learns across the sequence.
// Every session is a fresh `claude -p` in a repo rebuilt from the reference state (workspace.js), so both arms find
// the same code; only what the Agent remembers differs. Arms and reps run one after another (the s4 spec binds a
// fixed port, and heavy runs stay serial).
//
//   node acceptance/compounding-sessions/run.js --out <dir> --tag base --reps 2 \
//     --fuli-config <dir with mcp.json + settings.json> --fuli-data-dir <isolated data dir>
//
// Isolation: --strict-mcp-config (off: no servers), --settings (off: none), --setting-sources project,local, the
// same tools in both arms (PowerShell and web tools off, so shell work goes through Bash), no
// CLAUDE.md (CLAUDE_CODE_DISABLE_CLAUDE_MDS) and no Claude Code auto memory (CLAUDE_CODE_DISABLE_AUTO_MEMORY), so the
// only memory across sessions is FULI's. Uses the logged-in Claude Code; no credentials are read or copied.
// Synthetic data only: point --fuli-config/--fuli-data-dir at an isolated FULI, never the real one.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sessionReport } from './metrics.js';
import { SESSIONS } from './sessions.js';
import { buildRepo } from './workspace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  out: { type: 'string' },
  tag: { type: 'string', default: 'base' },
  arms: { type: 'string', default: 'off,fuli' },
  reps: { type: 'string', default: '2' },
  from: { type: 'string', default: '1' },
  sessions: { type: 'string', default: String(SESSIONS.length) },
  // Run only these sessions (still each from its own reference start state), e.g. s2,s3,s4,s5,s6.
  only: { type: 'string' },
  // Oracle arm: seed the new FULI project with confirmed knowledge (a JSON list of { key, name, summary }) before its
  // first session, as if earlier sessions had kept exactly that. Measures what recall can save at best.
  seed: { type: 'string' },
  model: { type: 'string', default: 'claude-haiku-5-5' },
  timeout: { type: 'string', default: '900' },
  'max-turns': { type: 'string', default: '60' },
  'max-cost': { type: 'string', default: '6' },
  'fuli-config': { type: 'string' },
  'fuli-data-dir': { type: 'string' },
  claude: { type: 'string', default: join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude') }
} });
if (!values.out) throw new Error('--out <dir> is required');
const arms = values.arms.split(',');
if (arms.includes('fuli') && (!values['fuli-config'] || !values['fuli-data-dir'])) {
  throw new Error('The fuli arm needs --fuli-config and --fuli-data-dir (an isolated FULI, never the real one)');
}

const OUT = resolve(values.out);
const RAW = join(OUT, 'raw', values.tag);
const RESULTS = join(OUT, 'results', values.tag);
for (const dir of [RAW, RESULTS]) mkdirSync(dir, { recursive: true });
const FOOTER = readFileSync(join(HERE, 'prompt-footer.txt'), 'utf8').trim();
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  appendFileSync(join(RAW, 'run.log'), `${text}\n`);
};
const costFile = join(RAW, 'cost.json');
const spent = () => (existsSync(costFile) ? JSON.parse(readFileSync(costFile, 'utf8')).usd : 0);
const addSpent = (usd) => writeFileSync(costFile, JSON.stringify({ usd: spent() + (usd ?? 0) }));
const jsonLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
  .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : []);

const fuliConfig = values['fuli-config'] ? resolve(values['fuli-config']) : null;
const CONFIG = {
  off: { mcp: JSON.stringify({ mcpServers: {} }), settings: '{}' },
  fuli: fuliConfig ? { mcp: join(fuliConfig, 'mcp.json'), settings: join(fuliConfig, 'settings.json') } : null
};
const BASE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'Bash(node:*)', 'Bash(node.exe:*)', 'Bash(npm test:*)',
  'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)', 'Bash(cat:*)'];
const TOOLS = { off: BASE_TOOLS, fuli: [...BASE_TOOLS, 'mcp__fuli'] };

// The launching Claude Code session's own variables are not passed on, so each run is a plain CLI session.
const PARENT = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_|ANTHROPIC_|BAGGAGE$|FULI_)/;
function sessionEnv(arm) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PARENT.test(key)));
  Object.assign(env, { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
  if (arm === 'fuli') env.FULI_DATA_DIR = values['fuli-data-dir'];
  return env;
}

// FULI's own CLI tool call, through the same server and runtime config the fuli arm's MCP uses.
function fuliCall(tool, input) {
  const mcp = JSON.parse(readFileSync(CONFIG.fuli.mcp, 'utf8')).mcpServers.fuli;
  const runtimeConfig = mcp.args[mcp.args.indexOf('--runtime-config') + 1];
  const result = spawnSync(mcp.command, [mcp.args[0], '--runtime-config', runtimeConfig, '--source-application', 'other',
    '--call', tool, '--input', JSON.stringify(input)], { encoding: 'utf8', timeout: 120_000, env: sessionEnv('fuli') });
  if (result.status !== 0) throw new Error(`FULI ${tool} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function registerProject(projectId) {
  const spaceId = fuliCall('list_knowledge_spaces', {}).activePersonalSpaceId;
  fuliCall('upsert_personal_project', { personalSpaceId: spaceId, projectId, profile: {
    name: `Tidewater (${projectId})`, purpose: 'Synthetic notification relay used by the FULI compounding-sessions eval.',
    scope: 'Synthetic benchmark project; no real data.', technicalSummary: 'Node 24 ESM, node:test.', lifecycle: 'active',
    sources: [], boundaries: ['Synthetic benchmark data only; never publish.'] } });
  if (values.seed) seedKnowledge(spaceId, projectId, JSON.parse(readFileSync(resolve(values.seed), 'utf8')));
}

function seedKnowledge(spaceId, projectId, items) {
  const at = new Date().toISOString();
  const by = { kind: 'user', label: 'benchmark operator' };
  fuliCall('capture_session_knowledge', { targetKind: 'personal', spaceId, personalProjectId: projectId,
    sessionId: `compound-seed-${projectId}`, idempotencyKey: `compound-seed-${projectId}`, name: 'Tidewater oracle knowledge',
    sourceKind: 'benchmark_seed', sourceDescription: 'Synthetic facts for the compounding-sessions oracle arm.',
    sourceApplication: 'other', referenceTime: at, sensitivity: 'normal', relationships: [],
    entities: items.map((item) => ({ ...item, key: `${projectId}:${item.key}`, type: 'ProjectKnowledge',
      originQuadrant: 'known_known', currentQuadrant: 'known_known', epistemicStatus: 'confirmed', confirmationStatus: 'confirmed',
      confirmationBasis: { existenceReason: 'Synthetic benchmark fact.', quadrantReason: 'Stated by the benchmark operator.',
        proposedBy: by, confirmedBy: by, confirmedAt: at },
      reasoningSummary: null, profileAspect: null, inheritanceMode: 'local_only', inheritedProjectIds: [], attributes: {} })) });
}

function runClaude({ arm, prompt, cwd, events }) {
  const config = CONFIG[arm];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', values.model,
    '--strict-mcp-config', '--mcp-config', config.mcp, '--settings', config.settings, '--setting-sources', 'project,local',
    '--max-turns', values['max-turns'], '--allowedTools', TOOLS[arm].join(','), '--disallowedTools', 'PowerShell,WebFetch,WebSearch'];
  const started = Date.now();
  return new Promise((done) => {
    const out = createWriteStream(events);
    const err = createWriteStream(`${events}.stderr`);
    const child = spawn(values.claude, args, { cwd, env: sessionEnv(arm), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.stdin.end(prompt);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, Number(values.timeout) * 1000);
    child.on('close', (rc) => {
      clearTimeout(timer);
      out.end(() => done({ rc, timedOut, secs: (Date.now() - started) / 1000 }));
    });
  });
}

function hiddenCheck(sessionId, repoDir) {
  const result = spawnSync(process.execPath, [join(HERE, 'checks.js'), sessionId, repoDir], { encoding: 'utf8', timeout: 600_000 });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { session: sessionId, pass: false, items: {}, errors: { checks: (result.stderr || result.stdout).slice(-400) } };
  }
}

const changedFiles = (repoDir) => spawnSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }).stdout
  .split('\n').filter(Boolean).map((line) => line.slice(3));

async function runChain(arm, rep) {
  const projectId = `tw-${values.tag}-r${rep}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const chain = `${arm}-r${rep}`;
  const repoDir = join(OUT, 'runs', values.tag, chain, projectId);
  const only = values.only ? new Set(values.only.split(',')) : null;
  const planned = SESSIONS.slice(0, Number(values.sessions)).map((session, index) => [index, session])
    .filter(([, session]) => !only || only.has(session.id));
  if (arm === 'fuli' && !existsSync(join(RESULTS, `${chain}-${planned[0][1].id}.json`))) registerProject(projectId);
  for (const [index, session] of planned) {
    const resultPath = join(RESULTS, `${chain}-${session.id}.json`);
    if (existsSync(resultPath)) { log(`${chain} ${session.id}: already done`); continue; }
    if (spent() > Number(values['max-cost'])) { log(`${chain}: cost cap ${values['max-cost']} USD reached`); return; }
    buildRepo(index, repoDir);
    const events = join(RAW, `${chain}-${session.id}.jsonl`);
    const prompt = `${session.prompt}\n\n${FOOTER}`;
    log(`${chain} ${session.id}: ${session.title}`);
    const run = await runClaude({ arm, prompt, cwd: repoDir, events });
    const report = sessionReport(jsonLines(events));
    addSpent(report.costUsd);
    const check = hiddenCheck(session.id, repoDir);
    const record = { tag: values.tag, arm, rep, session: session.id, index: index + 1, title: session.title, projectId,
      model: values.model, rc: run.rc, timedOut: run.timedOut, secs: run.secs, success: check.pass && run.rc === 0 && !run.timedOut,
      check, changedFiles: changedFiles(repoDir), ...report };
    writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`);
    log(`${chain} ${session.id}: success=${record.success} allInput=${report.usage.allInput} out=${report.usage.output} `
      + `cost=${report.costUsd} requests=${report.modelRequests} tools=${JSON.stringify(report.tools)} fuli=${report.fuli.calls.join(',')} `
      + `hook=${report.hooks.promptContextBytes}B secs=${run.secs.toFixed(0)}`);
  }
}

for (let rep = Number(values.from); rep <= Number(values.reps); rep += 1) {
  for (const arm of arms) {
    try {
      await runChain(arm, rep);
    } catch (error) {
      log(`${arm}-r${rep}: ERROR ${error.stack}`);
    }
  }
}
log(`finished; spent ${spent().toFixed(4)} USD (tag ${values.tag})`);
