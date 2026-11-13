import assert from 'node:assert/strict';
import test from 'node:test';

import { constrainedVisitClients, postRunCheck } from '../src/visit-requests/auto-envelope.js';

const file = (path) => ({ path, added: 1, removed: 0, binary: false, executable: false, symlink: false });
const denied = (path, platform = 'linux') => !postRunCheck({ files: [file(path)], addedText: '+x', platform })
  .checks.find((check) => check.name === 'no_denied_paths').ok;

test('the auto envelope denies files that run when the owner opens, builds or tests the branch', () => {
  for (const path of ['.vscode/tasks.json', '.idea/workspace.xml', '.devcontainer/devcontainer.json', '.claude/settings.json',
    '.cursor/rules/x.mdc', '.mcp.json', 'CLAUDE.md', 'docs/AGENTS.md', 'GEMINI.md', '.npmrc', '.yarnrc.yml', '.pnpmfile.cjs', '.envrc',
    'src/App.csproj', 'App.sln', 'Directory.Build.props', 'settings.gradle.kts', 'build.gradle', 'gradle/wrapper/gradle-wrapper.properties',
    'gradlew', 'gradlew.bat', 'mvnw', '.mvn/wrapper/maven-wrapper.properties', 'pom.xml', 'vite.config.ts', 'jest.config.cjs',
    'eslint.config.mjs', 'tests/conftest.py', 'setup.py', 'setup.cfg', 'pyproject.toml', 'Makefile', 'justfile', 'Rakefile',
    'tool.gemspec', 'flake.nix', '.pre-commit-config.yaml', 'lefthook.yml', '.husky/pre-commit', 'Dockerfile.dev',
    'docker-compose.override.yml', 'scripts/run.sh', 'scripts/run.ps1', 'run.bat', 'run.cmd', 'package.json', '.env.local']) {
    assert.equal(denied(path), true, path);
  }
  for (const path of ['src/server.js', 'docs/guide.md', 'README.md', 'src/config-reader.js', 'web/app.ts']) {
    assert.equal(denied(path), false, path);
  }
});

test('on Windows, where Git keeps no file modes, a file without an extension is denied too', () => {
  assert.equal(denied('bin/tool', 'win32'), true);
  assert.equal(denied('bin/tool', 'linux'), false, 'elsewhere its executable mode is checked instead');
  assert.equal(postRunCheck({ files: [{ ...file('bin/tool'), executable: true }], addedText: '', platform: 'linux' }).ok, false);
});

test('auto runs only with a client constrained without the owner\'s eye: Codex not on native Windows', () => {
  assert.deepEqual(constrainedVisitClients(['codex', 'claude_code'], 'win32'), ['claude_code']);
  assert.deepEqual(constrainedVisitClients(['codex', 'claude_code'], 'darwin'), ['codex', 'claude_code']);
  assert.deepEqual(constrainedVisitClients(['codex'], 'win32'), []);
});
