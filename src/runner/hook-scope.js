import { join } from 'node:path';

import { parseHookInput } from '../agents/lifecycle-input.js';
import { sqliteBusy } from '../../packages/roundtable/src/storage/database-format.js';
import { LOCAL_OWNER, PROJECT_PREFIX, ROUTES_FILE, RoutesStore, routesAsTheyAre } from './routes-store.js';
import { issuedToken, ownIssuer, readIssued } from './task-issuer.js';

// Where a lifecycle hook on a follower runs (docs/runner-roles-design.md §4):
// the folder in its payload decides, by the rule the follower's MCP entry
// decides a call by (routed-calls.js callDestination, asked about that folder).
// A project routed to this computer by a route of its own is this computer's,
// so its hooks run here as on any FULI, with this computer's own runtime
// configuration, and its transcript stays here; every other folder goes as it
// went before (hook-forwarding.js, or nothing for the hooks a runner does not
// forward). lifecycle-forwarder.js loads this module only on a follower.
//
// Answers { here: false }, { here: true }, or { refused: { code, message } }
// when the folder may be this computer's and cannot be answered here: said as
// it is, never sent to the host instead (the project is not there).
//
// A follower with no project routed here reads the routes once and goes on:
// without such a route callDestination never answers `local` for a call
// without a task token, which a hook's payload never carries. The routes are
// read as they are (routes-store.js routesAsTheyAre), never migrated or
// waited on here: a store at another version, being migrated or held by
// another connection has no project of this computer's for the hook, which
// goes as it went before; the MCP entry and the console migrate it.
export async function hookDestination({ dataDir, input }) {
  const folder = input?.cwd;
  if (typeof folder !== 'string' || !folder) return ELSEWHERE;
  let routes;
  try {
    routes = routesAsTheyAre(join(dataDir, ROUTES_FILE));
  } catch (error) {
    return { refused: await routesUnreadable(error) };
  }
  if (!routes) return ELSEWHERE;
  try {
    let owned;
    try {
      owned = routes.all().some(({ scope, owner }) => owner === LOCAL_OWNER && scope.startsWith(PROJECT_PREFIX));
    } catch (error) {
      if (sqliteBusy(error)) return ELSEWHERE;
      return { refused: await routesUnreadable(error) };
    }
    if (!owned) return ELSEWHERE;
    const [{ callDestination }, { RUNNER_FILE, RunnerStore }] = await Promise.all([import('./routed-calls.js'), import('./runner-store.js')]);
    let hostName;
    try {
      const store = new RunnerStore(join(dataDir, RUNNER_FILE));
      try {
        if (callDestination({ routes, store, input: { projectPath: folder } }).to !== 'local') return ELSEWHERE;
        hostName = store.host()?.name ?? 'your FULI host';
      } finally {
        store.close();
      }
    } catch (error) {
      if (sqliteBusy(error)) return ELSEWHERE;
      return { refused: refusal('hook_route_unknown',
        `This computer could not tell whether this folder's project is answered here or by its FULI host (${detail(error)}), `
        + 'so this hook sent nothing anywhere. `fuli routes list` shows which computer each project belongs to.',
        `这台电脑没能判断这个文件夹的项目由本机还是主机回答（${detail(error)}），所以这个钩子什么都没发。\`fuli routes list\` 列出每个项目归哪台电脑。`) };
    }
    const { localRuntimeLine, localRuntimeStep, localRuntimeStepZh, readLocalRuntime } = await import('./follower-local-runtime.js');
    const runtime = readLocalRuntime(dataDir);
    if (runtime.state !== 'ready') {
      const line = localRuntimeLine(runtime);
      return { refused: refusal('local_runtime_not_ready',
        `This folder's project is on this computer, and this computer's own FULI cannot answer it yet. ${line.en} `
        + `${localRuntimeStep(runtime) ?? ''} Nothing was sent to ${hostName}: the project is not there.`,
        `这个文件夹的项目在这台电脑上，但这台电脑自己的 FULI 现在还不能回答。${line.zh}`
        + `${localRuntimeStepZh(runtime) ?? ''}没有发给 ${hostName}：项目不在那里。`) };
    }
    return { here: true, hostName };
  } finally {
    routes.close();
  }
}

// What a project of this computer's answers when its hook could not run here (its runtime could not open).
export function unavailableHere(error, hostName) {
  return refusal('local_unavailable',
    `This folder's project is on this computer, and its FULI could not run this hook (${detail(error)}). `
    + `Start FULI here (FULI.app, or \`fuli start\`) and try again. Nothing was sent to ${hostName}: the project is not there.`,
    `这个文件夹的项目在这台电脑上，但这台电脑的 FULI 没能运行这个钩子（${detail(error)}）。启动这台电脑上的 FULI（FULI.app 或 \`fuli start\`）后再试。`
    + `没有发给 ${hostName}：项目不在那里。`);
}

// A hook run here, as the client is given it: each task token in its answer
// names this computer, and is remembered as this computer's task, as the
// follower's MCP entry does with a task this computer's half entered
// (runner-mcp.js answerHere). So the task's later calls come back here, the
// ones that carry only the token too. A token this computer could not
// remember stays as the hook wrote it: a call with it and this folder still
// comes here by the folder, where one naming this computer would not. A
// prompt that entered no task (this computer's FULI did not answer) says
// which computer it was and what to do, after the hook's own words.
export function answeredHere(dataDir, result, { event, hostName }) {
  const tokens = entryTokens(result.stdout);
  if (!tokens.length) return event === 'UserPromptSubmit' ? withNote(result, noTaskHere(hostName)) : result;
  const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
  try {
    for (const token of tokens) routes.rememberTaskOwner(token, LOCAL_OWNER);
  } catch (error) {
    return { ...result, stderr: `${result.stderr ?? ''}FULI could not remember this task as this computer's (${detail(error)}); `
      + 'its calls go by their folder.\n' };
  } finally {
    routes.close();
  }
  const own = ownIssuer(dataDir);
  if (!own) return result;
  return { ...result, stdout: tokens.reduce((stdout, token) => stdout.split(token).join(issuedToken(own, token)), result.stdout) };
}

function noTaskHere(hostName) {
  return `This folder's project is on this computer, and this computer's FULI entered no task for this prompt. If FULI `
    + `is not running here, start it (FULI.app, or \`fuli start\`). Nothing was sent to ${hostName}: the project is not there.\n`
    + `这个文件夹的项目在这台电脑上，这台电脑的 FULI 没有为这次提问建立任务。如果这台电脑上的 FULI 没在运行，请启动它（FULI.app 或 \`fuli start\`）。`
    + `没有发给 ${hostName}：项目不在那里。`;
}

// The hook's answer with a line after its model-visible context, where the client shows one.
function withNote(result, note) {
  let answer;
  try { answer = JSON.parse(result.stdout); } catch { return result; }
  const context = answer?.hookSpecificOutput?.additionalContext;
  if (typeof context !== 'string') return result;
  return { ...result, stdout: `${JSON.stringify({ ...answer,
    hookSpecificOutput: { ...answer.hookSpecificOutput, additionalContext: `${context}\n${note}` } })}\n` };
}

const ELSEWHERE = Object.freeze({ here: false });

export function runnerHookInput(stdin) {
  try { return parseHookInput(Buffer.concat(stdin)); } catch { return null; }
}

// A host on an older version may still send a refresh. Preserve an explicit
// block when the host could not protect ownership of the turn.
export function quietForwardedOutput(stdout) {
  try { if (JSON.parse(stdout)?.decision === 'block') return stdout; } catch { /* no valid hook answer */ }
  return '{}\n';
}

// The task tokens a hook's answer gives: a token field of the answer, or one
// written in its text (the entry's JSON inside the model-visible context).
const TOKEN_FIELDS = new Set(['taskContextToken', 'task_context_token']);
const TOKEN_IN_TEXT = /"(?:taskContextToken|task_context_token)"\s*:\s*"([^"\\]{1,200})"/g;

function entryTokens(stdout) {
  let answer;
  try { answer = JSON.parse(stdout); } catch { return []; }
  const found = new Set();
  const visit = (value, field) => {
    if (typeof value === 'string') {
      if (TOKEN_FIELDS.has(field)) found.add(value);
      else for (const match of value.matchAll(TOKEN_IN_TEXT)) found.add(match[1]);
    } else if (value && typeof value === 'object') {
      for (const [name, inner] of Object.entries(value)) visit(inner, name);
    }
  };
  visit(answer, null);
  // A token that already names its issuer is not this computer's to name.
  return [...found].filter((token) => token && !readIssued(token));
}

async function routesUnreadable(error) {
  const [{ routesUnavailableAnswer }, { resultValue }] = await Promise.all([import('./routed-calls.js'), import('./offline-calls.js')]);
  const { code, message } = resultValue(routesUnavailableAnswer(error));
  return { code, message };
}

function refusal(code, en, zh) {
  return { code, message: `${en}\n${zh}` };
}

function detail(error) {
  return String(error?.message ?? error).slice(0, 300);
}
