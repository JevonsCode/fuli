import { AsyncLocalStorage } from 'node:async_hooks';

import { InvalidInputError } from '../app/application-error.js';
import { resolvePersonalProjectPath } from './project-path-context.js';
import { workspaceFileSystem } from './workspace-facts.js';

// Where the folders a call names are. A local client's folders are on this
// computer's disk; a runner's (docs/runner.md) are on the runner, and for the
// length of its call this answers each path from the facts that runner sent
// (workspace-facts.js). Every path question of task entry goes through here,
// so a runner's folder is matched and registered by the local rules.
const callerWorkspaces = new AsyncLocalStorage();

// lookup(projectPath) → the runner's facts for that path, or null.
export function runWithCallerWorkspaces(lookup, operation) {
  if (typeof lookup !== 'function') throw new TypeError('Caller workspace lookup is required');
  return callerWorkspaces.run({ lookup }, operation);
}

// The app's default project path resolver.
export function resolveCallerProjectPath(projectPath, projects, options) {
  const facts = remoteFacts(projectPath);
  return facts
    ? resolvePersonalProjectPath(projectPath, projects, workspaceFileSystem(facts))
    : resolvePersonalProjectPath(projectPath, projects, options);
}

// The README draft and origin source a runner sent for its folder; null for a
// local caller, who reads its own repository.
export function callerRepository(projectPath) {
  const facts = remoteFacts(projectPath);
  return facts ? { draft: facts.draft, source: facts.originSource } : null;
}

function remoteFacts(projectPath) {
  const scope = callerWorkspaces.getStore();
  if (!scope || typeof projectPath !== 'string') return null;
  const facts = scope.lookup(projectPath);
  if (!facts) {
    throw new InvalidInputError('projectPath was not described by this runner. '
      + 'Pass the absolute path of the current working directory.');
  }
  return facts;
}
