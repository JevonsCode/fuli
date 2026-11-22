import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { describeWorkspace } from '../graphiti/workspace-facts.js';
import { isRunnerDataDirectory } from '../runner/runner-mode.js';
import { projectIdentityCache } from '../system/project-identity-cache.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { localConsoleUrl } from './console-url.js';
import { writeLine } from './terminal-io.js';

const USAGE = `fuli whoami [--project ID_OR_FOLDER] [--json] [--data-dir DIR]
  Which space and project this folder belongs to, which FLA leads it, and whether this
  computer is the FULI host or a runner. Read only; it returns no token or address.
  Without --project it asks about the current folder. On a runner the host answers; while
  the host is away its last answer is shown, marked offline with the time it was given.`;
// Nothing could be answered, not even from an earlier answer.
const UNANSWERED_EXIT_CODE = 2;

export async function runWhoAmICommand(args, { env = process.env, write = writeLine, fetchImpl = fetch,
  cwd = () => process.cwd(), isRunner = isRunnerDataDirectory, workspaceFacts = describeWorkspace } = {}) {
  const options = parseOptions(args);
  if (options.help) {
    write(USAGE);
    return { exitCode: 0 };
  }
  const paths = resolveSetupPaths({ dataDir: options.dataDir, env });
  const runner = isRunner(paths.dataDir);
  const asked = askedAbout(options.project, cwd);
  const cache = projectIdentityCache(paths.dataDir);
  const key = asked.projectPath ?? `id:${asked.personalProjectId}`;

  let answer = null;
  let failure = null;
  try {
    // A runner's folder is on the runner, so the host resolves it from the folder's
    // facts, by exactly the rules it would use for its own (workspace-facts.js).
    const workspace = runner && asked.projectPath ? await workspaceFacts(asked.projectPath) : null;
    const reply = await fetchImpl(`${localConsoleUrl({ dataDir: options.dataDir, env })}/api/whoami`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...asked, ...(workspace ? { workspace } : {}) })
    });
    if (!reply.ok) throw new Error(`the console answered ${reply.status}`);
    answer = await reply.json();
  } catch (error) {
    failure = error instanceof Error ? error.message : 'the console did not answer';
  }

  if (answer) {
    const computer = { role: runner ? 'runner' : 'host', ...(runner ? { hostReachable: true } : {}) };
    if (runner) cache.remember(key, answer);
    return finish({ ...answer, computer, offline: false }, options, write);
  }
  // The host is away, or no console is running here: the earlier answer is better
  // than nothing, as long as it says it is earlier (rec#144).
  const earlier = runner ? cache.last(key) : null;
  if (!earlier) {
    write(runner
      ? `No answer: ${failure}. The host has not answered this folder before, so nothing is kept here. `
        + 'Check the pairing with `fuli runner status`.'
      : `No answer: ${failure}. Start FULI with \`fuli start\`.`);
    return { exitCode: UNANSWERED_EXIT_CODE };
  }
  return finish({ ...earlier.answer, computer: { role: 'runner', hostReachable: false },
    offline: true, answeredAt: earlier.at }, options, write);
}

function finish(answer, options, write) {
  write(options.json ? JSON.stringify(answer, null, 2) : format(answer));
  return { exitCode: 0, answer };
}

function format(answer) {
  const lines = [`Space: ${answer.space.name ?? '—'} (${answer.space.id})`];
  lines.push(answer.project
    ? `Project: ${answer.project.name} (${answer.project.id})`
    : `Project: none matched (${answer.projectResolution})`);
  lines.push(answer.lead ? `Lead FLA: ${answer.lead.name} (${answer.lead.id})`
    : answer.project ? 'Lead FLA: none chosen for this project' : 'Lead FLA: —');
  lines.push(answer.computer.role === 'runner'
    ? `This computer: a runner; its FULI is on the host (${answer.computer.hostReachable ? 'answering' : 'not reachable now'})`
    : 'This computer: the FULI host');
  if (answer.offline) lines.push(`Offline: this is the host's earlier answer, given ${answer.answeredAt}.`);
  return lines.join('\n');
}

// --project takes a folder or a project ID; an existing directory is a folder.
function askedAbout(project, cwd) {
  if (!project) return { projectPath: cwd() };
  const path = isAbsolute(project) ? project : resolve(cwd(), project);
  const isFolder = (project.includes('/') || project.includes('\\') || project === '.' || project === '..')
    || (existsSync(path) && safeIsDirectory(path));
  return isFolder ? { projectPath: path } : { personalProjectId: project };
}

function safeIsDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function parseOptions(args) {
  const options = { project: null, json: false, dataDir: undefined, help: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--project' || flag === '--data-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new TypeError(`Missing value: ${flag}\n${USAGE}`);
      if (flag === '--project') options.project = value;
      else options.dataDir = value;
    } else throw new TypeError(`Invalid whoami option: ${flag}\n${USAGE}`);
  }
  return options;
}
