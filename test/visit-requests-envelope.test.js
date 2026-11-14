import assert from 'node:assert/strict';
import test from 'node:test';

import { postRunCheck } from '../src/visit-requests/auto-envelope.js';
import { gitDirectoryName, gitModulesName } from '../src/visit-requests/git-names.js';

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
    'docker-compose.override.yml', 'scripts/run.sh', 'scripts/run.ps1', 'run.bat', 'run.cmd', 'package.json', '.env.local',
    'build.rs', '.cargo/config.toml', '.eslintrc.js', '.eslintrc.cjs', '.babelrc.js', '.prettierrc.js', '.prettierrc.cjs', 'vite.config.mts',
    'tool.config.cts', 'App.targets', 'Shared.props', 'gulpfile.js', 'Gruntfile.coffee', 'CMakeLists.txt', 'cmake/deps.cmake', 'pytest.ini',
    'tox.ini', 'noxfile.py', 'site-packages/evil.pth', 'sitecustomize.py', 'usercustomize.py']) {
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

test('names Git or the file system treat as .git or .gitmodules are recognised under any spelling', () => {
  for (const name of ['.git', '.GIT', '.Git', 'git~1', 'GIT~1', '.git.', '.git ', '.git. .', '.g\u200bit', '\ufeff.git']) {
    assert.equal(gitDirectoryName(name), true, JSON.stringify(name));
  }
  for (const name of ['.gitmodules', '.GITMODULES', 'gitmod~1', '.gitmodules.', '.git\u200cmodules']) {
    assert.equal(gitModulesName(name), true, JSON.stringify(name));
  }
  for (const name of ['.github', 'git', '.gitignore', 'my.git', '.gitkeep']) {
    assert.equal(gitDirectoryName(name) || gitModulesName(name), false, name);
  }
});
