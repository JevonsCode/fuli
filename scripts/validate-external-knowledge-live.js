import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ExternalKnowledgeRegistry,
  ExternalKnowledgeService
} from '../src/external-knowledge/index.js';
import { createCustomConnector } from '../src/external-knowledge/connectors/custom.js';

const run = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  {
    id: 'mcp-spec',
    name: 'MCP specification and documentation',
    repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol.git',
    query: 'authorization resources'
  },
  {
    id: 'notion-sdk',
    name: 'Notion JavaScript SDK documentation',
    repository: 'https://github.com/makenotion/notion-sdk-js.git',
    query: 'notion client'
  }
];

const temporaryRoot = await mkdtemp(join(tmpdir(), 'fuli-external-knowledge-live-'));
let cleaned = false;

try {
  const connectorDirectory = join(temporaryRoot, 'connectors');
  await mkdir(connectorDirectory, { recursive: true });
  await copyFile(
    join(repositoryRoot, 'examples', 'external-knowledge', 'markdown-folder.mjs'),
    join(connectorDirectory, 'markdown-folder.mjs')
  );

  for (const source of sources) {
    const checkout = join(temporaryRoot, 'knowledge-bases', source.id);
    await mkdir(dirname(checkout), { recursive: true });
    process.stdout.write(`下载公开知识库：${source.name}\n`);
    await clonePublicRepository(source, checkout);
    source.path = checkout;
  }

  const captured = [];
  const connector = createCustomConnector({ directory: connectorDirectory });
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [{ project_id: 'live-validation-project' }],
      captureSessionKnowledge: async (episode) => {
        captured.push(episode);
        return {
          status: 'accepted',
          entity_ids: episode.entities.map((_, index) =>
            `validation-entity-${captured.length}-${index + 1}`
          )
        };
      }
    },
    registry: new ExternalKnowledgeRegistry(join(temporaryRoot, 'bindings.json')),
    connectors: { get: (type) => type === 'custom' ? connector : null },
    createId: () => 'public-docs-validation'
  });
  const rootSource = {
    roots: sources.map(({ id, path }) => ({ id, path })),
    extensions: ['.md', '.mdx'],
    maxFiles: 2_000,
    maxFileBytes: 1_000_000
  };
  await service.createBinding({
    name: 'Public documentation validation',
    connectorType: 'custom',
    connectorConfig: {
      module: 'markdown-folder.mjs',
      environmentNames: []
    },
    source: rootSource,
    target: {
      personalSpaceId: 'live-validation-space',
      personalProjectId: 'live-validation-project'
    },
    mode: 'hybrid'
  });
  const sync = await service.syncBinding('public-docs-validation', {
    maxPages: 100,
    pageSize: 100
  });
  assert.ok(sync.imported >= 2, 'Expected documents from both public repositories');
  assert.ok(captured.length >= 2, 'Expected public documents to reach the mapping boundary');
  assert.ok(captured.every((episode) =>
    episode.sourceApplication === 'other' &&
    episode.sensitivity === 'restricted' &&
    episode.entities.every((entity) =>
      entity.confirmationStatus === 'pending' &&
      entity.epistemicStatus === 'observed'
    )
  ));

  for (const source of sources) {
    const result = await service.retrieveBinding('public-docs-validation', {
      query: source.query,
      limit: 5
    });
    assert.ok(
      result.items.some(({ id }) => id.startsWith(`${source.id}:`)),
      `Expected a retrieval hit from ${source.name}`
    );
    process.stdout.write(`只读检索通过：${source.name}\n`);
  }
  process.stdout.write(
    `同步映射通过：${sync.imported} 个真实公开文档；安全跳过 ${sync.skippedCredentials} 个\n`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  await assert.rejects(access(temporaryRoot), { code: 'ENOENT' });
  cleaned = true;
  process.stdout.write('临时知识库已清理。\n');
}

assert.equal(cleaned, true);

async function clonePublicRepository(source, checkout) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await rm(checkout, { recursive: true, force: true });
    try {
      await run('git', [
        '-c', 'http.version=HTTP/1.1',
        'clone',
        '--depth', '1',
        '--no-tags',
        '--single-branch',
        source.repository,
        checkout
      ], {
        env: isolatedGitEnvironment(),
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        process.stdout.write(`下载重试 ${attempt}/2：${source.name}\n`);
      }
    }
  }
  throw lastError;
}

function isolatedGitEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      !/^(?:GIT_|GCM_|GH_|GITHUB_|GITLAB_|SSH_ASKPASS)/iu.test(name) &&
      !/(?:TOKEN|CREDENTIAL|PRIVATE_KEY)$/iu.test(name)
    )
  );
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
}
