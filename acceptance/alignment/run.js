#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FederatedGraphApplication } from '../../src/graphiti/federated-application.js';
import { connectClaudeCode } from '../../src/setup/claude-code-config.js';
import {
  classifyClaudeCaseStatus,
  composeResourcesRemoved,
  isClaudeInfrastructureError,
  summarizeClaudeExecutionError
} from './benchmark-policy.js';

const ALIGNMENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(ALIGNMENT_DIR, '../..');
const FIXTURE_ROOT = join(ALIGNMENT_DIR, 'fixtures');
const COMPOSE_PATH = join(ALIGNMENT_DIR, 'compose.yml');
const RESULT_PATH = join(ALIGNMENT_DIR, 'results', 'latest.json');
const HOOK_SMOKE_RESULT_PATH = join(
  ALIGNMENT_DIR,
  'results',
  'hook-smoke-latest.json'
);
const REPORT_PATH = join(REPOSITORY_ROOT, 'FULI_CLAUDE_CODE_ALIGNMENT_REPORT.md');
const REFERENCE_TIME = '2026-07-31T00:00:00.000Z';
const FIXTURE_VERSION = 'alignment-v2';
const PROJECTS = Object.freeze({
  parent: 'platform-a',
  hotel: 'hotel-b',
  flight: 'flight-c',
  travel: 'travel-d',
  unrelated: 'botany-e'
});
const COMMON_RETRY_MARKER = 'RETRY-COMMON-271';
const CLAUDE_CAPTURE_MARKER = 'LOYALTY-WINDOW-503';
const CLAUDE_MODEL = nonEmpty(process.env.FULI_ALIGNMENT_CLAUDE_MODEL) ?? 'sonnet';
const CLAUDE_EFFORT = claudeEffort(process.env.FULI_ALIGNMENT_CLAUDE_EFFORT);
const CLAUDE_BUDGET_USD = positiveNumber(
  process.env.FULI_ALIGNMENT_CLAUDE_BUDGET_USD,
  0.40
);
const FULI_START_SYSTEM_PROMPT = [
  'Fuli task context is loaded by a lifecycle hook. Apply the returned preferences.',
  'For project facts, use mcp__fuli__search_current_project_knowledge so project',
  'scope and allowed parent inheritance are resolved without copying IDs.',
  'Before finishing, call mcp__fuli__checkpoint_task_knowledge exactly once with',
  'capture_candidates or retain_nothing. Never force a knowledge write.'
].join(' ');
const CLAUDE_BUILT_IN_TOOLS = Object.freeze([
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TaskStop'
]);
const SKIP_CLAUDE = process.argv.slice(2).includes('--skip-claude');
const SUPPORTED_ARGUMENTS = new Set(['--skip-claude']);
const activeChildren = new Set();

validateArguments(process.argv.slice(2));

const state = {
  app: null,
  composeAttempted: false,
  composeEnvironment: null,
  composeProject: null,
  temporaryRoot: null,
  cleanupPromise: null
};
const benchmark = {
  schemaVersion: 1,
  run: {
    benchmarkVersion: FIXTURE_VERSION,
    startedAt: new Date().toISOString(),
    completedAt: null,
    fixtureDocumentCount: countMarkdownFiles(FIXTURE_ROOT),
    dataClassification: 'synthetic_acceptance_fixture',
    isolation: {
      existingFuliGraphTouched: false,
      rawClaudeTranscriptsPersisted: false,
      temporaryRuntimeRemoved: null,
      dockerVolumeRemoved: null
    },
    claude: {
      requested: !SKIP_CLAUDE,
      model: CLAUDE_MODEL,
      effort: CLAUDE_EFFORT,
      maxBudgetUsdPerCall: CLAUDE_BUDGET_USD,
      version: null,
      calls: 0,
      totalDurationMs: 0,
      totalCostUsd: 0
    }
  },
  summary: null,
  cases: [],
  limitations: [
    'The corpus is synthetic and cannot estimate production precision by itself.',
    'Claude cases are a single-run behavioral check, not a statistically powered model comparison.',
    'Common-candidate discovery is inferred and read-only; human confirmation is scored separately from similarity.',
    'The five-run Agent comparison is a smoke test, not the 30-task product-claim tier defined by Benchmark v2.',
    'Only sanitized case evidence is persisted; raw Claude Code streams are discarded.'
  ]
};

installSignalHandlers();
await executeBenchmark();

async function executeBenchmark() {
  let infrastructureError = null;
  try {
    stage('创建一次性语料副本与隔离运行时');
    state.temporaryRoot = mkdtempSync(join(tmpdir(), 'fuli-alignment-'));
    const fixtureWorkspaces = join(state.temporaryRoot, 'fixture-workspaces');
    const emptyWorkspaces = join(state.temporaryRoot, 'empty-workspaces');
    cpSync(FIXTURE_ROOT, fixtureWorkspaces, { recursive: true });
    for (const projectId of Object.values(PROJECTS)) {
      const directory = join(emptyWorkspaces, projectId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        `${JSON.stringify({
          name: `synthetic-${projectId}`,
          private: true,
          description: 'Synthetic acceptance marker; not a production package.'
        }, null, 2)}\n`,
        'utf8'
      );
    }

    const [neo4jHttpPort, neo4jBoltPort, providerPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort()
    ]);
    state.composeProject = `fuli-alignment-${process.pid}-${randomBytes(3).toString('hex')}`;
    state.composeEnvironment = {
      ...process.env,
      FULI_ALIGNMENT_NEO4J_PASSWORD: randomBytes(32).toString('hex'),
      FULI_ALIGNMENT_BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'),
      FULI_ALIGNMENT_NEO4J_HTTP_PORT: String(neo4jHttpPort),
      FULI_ALIGNMENT_NEO4J_BOLT_PORT: String(neo4jBoltPort),
      FULI_ALIGNMENT_PROVIDER_PORT: String(providerPort)
    };
    state.composeAttempted = true;

    stage('启动独立 Neo4j 与 Fuli Provider');
    await runProcess('docker', [
      'compose',
      '-p', state.composeProject,
      '-f', COMPOSE_PATH,
      'up', '-d', '--build'
    ], {
      cwd: REPOSITORY_ROOT,
      env: state.composeEnvironment,
      timeoutMs: 8 * 60_000
    });

    const providerUrl = `http://127.0.0.1:${providerPort}`;
    await waitForProvider(providerUrl);
    const identity = await bootstrapProvider(
      providerUrl,
      state.composeEnvironment.FULI_ALIGNMENT_BOOTSTRAP_TOKEN
    );
    const personalSpace = await createPersonalSpace(providerUrl, identity.access_token);
    const runtimeConfig = {
      version: 1,
      personal: {
        providerUrl,
        accessToken: identity.access_token,
        principalId: identity.principal_id,
        spaceId: personalSpace.id
      },
      workspaces: []
    };
    const runtimeConfigPath = join(state.temporaryRoot, 'graph-runtime.json');
    const mcpConfigPath = join(state.temporaryRoot, 'claude-mcp-always-load.json');
    const claudeSettingsPath = join(state.temporaryRoot, 'claude-settings.json');
    const lifecycleAuditPath = join(state.temporaryRoot, 'lifecycle-audit.jsonl');
    writePrivateJson(runtimeConfigPath, runtimeConfig);
    writePrivateJson(mcpConfigPath, { mcpServers: {} });
    writePrivateJson(claudeSettingsPath, {});
    connectClaudeCode({
      id: 'claude-code',
      label: 'Claude Code',
      configPath: mcpConfigPath,
      settingsPath: claudeSettingsPath
    }, {
      nodePath: process.execPath,
      mcpServerPath: join(REPOSITORY_ROOT, 'src', 'mcp-server.js'),
      runtimeConfigPath
    });
    const claudeMcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    claudeMcpConfig.mcpServers.fuli.env = {
      FULI_ACCEPTANCE_LIFECYCLE_AUDIT_PATH: lifecycleAuditPath
    };
    writePrivateJson(mcpConfigPath, claudeMcpConfig);
    chmodSync(mcpConfigPath, 0o600);
    chmodSync(claudeSettingsPath, 0o600);

    state.app = new FederatedGraphApplication(runtimeConfig, {
      providerRequestTimeoutMs: 4 * 60_000
    });

    stage('写入 A、B、C、D 与负向对照项目的合成知识');
    const fixture = await seedFixture(state.app, personalSpace.id);

    stage('验证继承、隔离、覆盖、时间、冲突、幂等与自动上收');
    await runDeterministicCases(
      state.app,
      personalSpace.id,
      fixture,
      emptyWorkspaces
    );

    if (SKIP_CLAUDE) {
      addSkippedClaudeCases();
    } else {
      stage('由真实 Claude Code 执行捕获、全新会话检索与无 Fuli 对照');
      await runClaudeCases({
        app: state.app,
        personalSpaceId: personalSpace.id,
        fixtureWorkspaces,
        emptyWorkspaces,
        mcpConfigPath,
        claudeSettingsPath,
        lifecycleAuditPath
      });
    }

    stage('验证显式、可审计的公共知识上收流程');
    await runCuratedConvergenceCase(state.app, personalSpace.id, fixture);
  } catch (error) {
    infrastructureError = sanitizeError(error);
    addCase({
      id: 'INFRA-01',
      title: '隔离验收基础设施完整运行',
      domain: 'infrastructure',
      status: 'ERROR',
      expected: '独立 Provider、Neo4j、Fuli MCP 和 Claude Code 驱动器可完成运行。',
      observed: infrastructureError,
      evidence: []
    });
  } finally {
    stage('清理独立容器、数据卷与临时运行时');
    const cleanup = await cleanupRuntime();
    benchmark.run.isolation.temporaryRuntimeRemoved = cleanup.temporaryRuntimeRemoved;
    benchmark.run.isolation.dockerVolumeRemoved = cleanup.dockerVolumeRemoved;
  }

  benchmark.run.completedAt = new Date().toISOString();
  benchmark.summary = summarize(benchmark.cases, infrastructureError);
  writeOutputs(benchmark);
  printSummary(benchmark);
  if (infrastructureError) process.exitCode = 1;
}

async function seedFixture(app, personalSpaceId) {
  await Promise.all([
    upsertProject(app, personalSpaceId, PROJECTS.parent, {
      name: '活动平台 A（合成）',
      purpose: '三个领域项目共用的仓库与平台约定。',
      scope: '公共接口、测试、部署与可观测性。',
      technicalSummary: '合成的模块化活动平台父项目。',
      sources: ['platform-a/01-repository.md', 'platform-a/02-api-conventions.md']
    }),
    upsertProject(app, personalSpaceId, PROJECTS.hotel, {
      name: '酒店活动 B（合成）',
      purpose: '酒店活动领域规则。',
      scope: '酒店房态、活动与优惠券。',
      technicalSummary: 'platform-a 的合成子项目。',
      sources: ['hotel-b/01-prd.md', 'hotel-b/03-cache-override.md']
    }),
    upsertProject(app, personalSpaceId, PROJECTS.flight, {
      name: '机票活动 C（合成）',
      purpose: '机票活动领域规则。',
      scope: '航线、舱位与出票。',
      technicalSummary: 'platform-a 的合成子项目。',
      sources: ['flight-c/01-prd.md', 'flight-c/03-retry-candidate.md']
    }),
    upsertProject(app, personalSpaceId, PROJECTS.travel, {
      name: '旅行套餐 D（合成）',
      purpose: '旅行套餐领域规则。',
      scope: '套餐报价与资源组合。',
      technicalSummary: 'platform-a 的合成子项目。',
      sources: ['travel-d/01-prd.md', 'travel-d/03-retry-candidate.md']
    }),
    upsertProject(app, personalSpaceId, PROJECTS.unrelated, {
      name: '植物目录 E（合成）',
      purpose: '无关检索负向对照。',
      scope: '植物目录。',
      technicalSummary: '与活动平台无继承关系。',
      sources: ['botany-e/01-catalog.md']
    })
  ]);

  const parentInput = captureInput({
    personalSpaceId,
    projectId: PROJECTS.parent,
    idempotencyKey: `${FIXTURE_VERSION}:parent:base`,
    name: '父项目公共规则合成夹具',
    sourceDescription: '合成验收文档明确给出的父项目公共与受限规则。',
    entities: [
      fixtureEntity({
        key: 'alignment:shared:api-envelope',
        name: '公共 API 响应封装',
        summary: '所有活动接口使用 FULI-DEMO-ENVELOPE-v3，顶层字段为 trace、payload、fault。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'alignment:shared:mock-failure',
        name: '公共 Mock 可恢复故障',
        summary: '公共 Mock 使用 SIM-4187 模拟可恢复下游失败。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'alignment:shared:deployment',
        name: '公共部署门禁',
        summary: 'CANARY-7X18：先放量 7%，观察 18 minutes，再决定继续或回滚。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'alignment:shared:trace-header',
        name: '公共追踪请求头',
        summary: 'TRACE-HEADER-883：跨模块追踪使用 x-fixture-trace。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'shared.cache.ttl',
        name: '公共缓存时长',
        summary: '父项目默认活动列表缓存为 180 seconds。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'alignment:parent:local-only',
        name: '父项目本地迁移检查',
        summary: 'PARENT-LOCAL-931 只能在父项目使用。',
        inheritanceMode: 'local_only'
      }),
      fixtureEntity({
        key: 'alignment:parent:selected-hotel',
        name: '酒店定向公共规则',
        summary: 'SELECTED-HOTEL-742 只授权给酒店子项目。',
        inheritanceMode: 'selected_projects',
        inheritedProjectIds: [PROJECTS.hotel]
      }),
      fixtureEntity({
        key: 'alignment:shared:repository',
        name: '公共仓库边界',
        summary: 'SHARED-REPO-604：公共接口、测试、部署脚本归 platform-a，领域判断留在子项目。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'alignment:feedback:validation',
        name: '负面证据验收规则',
        summary: 'FEEDBACK-CHECK-662：仅用于验证失败证据降权，不是生产规则。',
        inheritanceMode: 'descendants'
      })
    ]
  });
  const parent = await capture(app, parentInput);

  const hotelInput = captureInput({
    personalSpaceId,
    projectId: PROJECTS.hotel,
    idempotencyKey: `${FIXTURE_VERSION}:hotel:base`,
    name: '酒店子项目合成夹具',
    sourceDescription: '合成验收文档明确给出的酒店领域规则。',
    entities: [
      fixtureEntity({
        key: 'alignment:anchor:hotel',
        name: '酒店项目关系锚点',
        summary: '仅用于建立 hotel-b PART_OF platform-a。'
      }),
      fixtureEntity({
        key: 'shared.cache.ttl',
        name: '酒店缓存时长覆盖',
        summary: '酒店房态变化更快，hotel-b 缓存为 45 seconds。'
      }),
      fixtureEntity({
        key: 'alignment:hotel:cutoff',
        name: '酒店取消截止',
        summary: 'HOTEL-CUTOFF-2140：取消截止时间为酒店当地时间 21:40。'
      }),
      fixtureEntity({
        key: 'alignment:hotel:retry-candidate',
        name: '酒店查询重试候选',
        summary: `${COMMON_RETRY_MARKER}：可恢复查询使用 2 attempts with 140ms jitter。`
      })
    ]
  });
  const hotel = await capture(app, hotelInput);

  const flightInput = captureInput({
    personalSpaceId,
    projectId: PROJECTS.flight,
    idempotencyKey: `${FIXTURE_VERSION}:flight:base`,
    name: '机票子项目合成夹具',
    sourceDescription: '合成验收文档明确给出的机票领域规则。',
    entities: [
      fixtureEntity({
        key: 'alignment:anchor:flight',
        name: '机票项目关系锚点',
        summary: '仅用于建立 flight-c PART_OF platform-a。'
      }),
      fixtureEntity({
        key: 'alignment:flight:freeze',
        name: '机票出票冻结窗口',
        summary: 'FLIGHT-FREEZE-052：出票冻结窗口为起飞前 52 minutes。'
      }),
      fixtureEntity({
        key: 'alignment:flight:retry-candidate',
        name: '机票查询重试候选',
        summary: `${COMMON_RETRY_MARKER}：可恢复失败总计 2 attempts with 140ms jitter。`
      })
    ]
  });
  const flight = await capture(app, flightInput);

  const travelInput = captureInput({
    personalSpaceId,
    projectId: PROJECTS.travel,
    idempotencyKey: `${FIXTURE_VERSION}:travel:base`,
    name: '旅行套餐子项目合成夹具',
    sourceDescription: '合成验收文档明确给出的旅行套餐领域规则。',
    entities: [
      fixtureEntity({
        key: 'alignment:anchor:travel',
        name: '旅行套餐项目关系锚点',
        summary: '仅用于建立 travel-d PART_OF platform-a。'
      }),
      fixtureEntity({
        key: 'alignment:travel:quote',
        name: '套餐报价有效期',
        summary: 'TRAVEL-QUOTE-011：打包价格有效期为 11 minutes。'
      }),
      fixtureEntity({
        key: 'alignment:travel:retry-candidate',
        name: '套餐报价重试候选',
        summary: `${COMMON_RETRY_MARKER}：可恢复失败采用 2 attempts with 140ms jitter。`
      })
    ]
  });
  const travel = await capture(app, travelInput);

  const unrelatedInput = captureInput({
    personalSpaceId,
    projectId: PROJECTS.unrelated,
    idempotencyKey: `${FIXTURE_VERSION}:unrelated:base`,
    name: '无关负向对照合成夹具',
    sourceDescription: '合成验收文档明确给出的无关植物目录。',
    entities: [
      fixtureEntity({
        key: 'alignment:anchor:botany',
        name: '植物目录关系锚点',
        summary: '仅用于建立 botany-e RELATED_TO platform-a。'
      }),
      fixtureEntity({
        key: 'alignment:botany:cedar',
        name: '雪松目录',
        summary: 'BOTANY-CEDAR-211：无关负向对照知识。'
      })
    ]
  });
  const unrelated = await capture(app, unrelatedInput);

  await Promise.all([
    relatePersonalProjects(
      app,
      personalSpaceId,
      hotel.ids['alignment:anchor:hotel'],
      PROJECTS.parent,
      'PART_OF'
    ),
    relatePersonalProjects(
      app,
      personalSpaceId,
      flight.ids['alignment:anchor:flight'],
      PROJECTS.parent,
      'PART_OF'
    ),
    relatePersonalProjects(
      app,
      personalSpaceId,
      travel.ids['alignment:anchor:travel'],
      PROJECTS.parent,
      'PART_OF'
    ),
    relatePersonalProjects(
      app,
      personalSpaceId,
      unrelated.ids['alignment:anchor:botany'],
      PROJECTS.parent,
      'RELATED_TO'
    )
  ]);

  const oldDecision = await capture(app, captureInput({
    personalSpaceId,
    projectId: PROJECTS.parent,
    idempotencyKey: `${FIXTURE_VERSION}:decision:redux`,
    name: '旧状态管理决定',
    sourceDescription: '合成决策时间线中的旧决定。',
    entities: [
      fixtureEntity({
        key: 'alignment:state:app',
        name: '活动应用',
        summary: '用于状态管理决策验收的合成应用。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'alignment:state:redux',
        name: 'Redux',
        summary: '旧状态管理方案。',
        inheritanceMode: 'descendants'
      })
    ],
    relationships: [
      fixtureRelationship({
        key: 'alignment:decision:redux',
        source: 'alignment:state:app',
        target: 'alignment:state:redux',
        type: 'USES_STATE',
        fact: 'STATE-REDUX-411：2026-01-10 的旧决定是使用 Redux。',
        validAt: '2026-01-10T00:00:00.000Z',
        inheritanceMode: 'descendants'
      })
    ]
  }));
  const currentDecision = await capture(app, captureInput({
    personalSpaceId,
    projectId: PROJECTS.parent,
    idempotencyKey: `${FIXTURE_VERSION}:decision:local-state`,
    name: '现行状态管理决定',
    sourceDescription: '合成决策时间线中的现行决定与替代原因。',
    entities: [
      fixtureEntity({
        key: 'alignment:state:app',
        name: '活动应用',
        summary: '用于状态管理决策验收的合成应用。',
        inheritanceMode: 'descendants'
      }),
      fixtureEntity({
        key: 'alignment:state:local',
        name: '局部状态',
        summary: '现行状态管理方案。',
        inheritanceMode: 'descendants'
      })
    ],
    relationships: [
      fixtureRelationship({
        key: 'alignment:decision:local-state',
        source: 'alignment:state:app',
        target: 'alignment:state:local',
        type: 'USES_STATE',
        fact: 'STATE-LOCAL-912：2026-03-02 移除 Redux，改用局部状态；原因是功能图缩减到 12 个以内。',
        validAt: '2026-03-02T00:00:00.000Z',
        supersedes: ['alignment:decision:redux'],
        inheritanceMode: 'descendants'
      })
    ]
  }));

  await capture(app, captureInput({
    personalSpaceId,
    projectId: null,
    idempotencyKey: `${FIXTURE_VERSION}:preferences`,
    name: '冲突与一次性偏好合成夹具',
    sourceDescription: '合成验收规范明确给出的偏好冲突和一次性选择。',
    entities: [
      fixtureEntity({
        key: 'alignment:preference:simple',
        name: '优先简单方案',
        summary: '小型模块优先简单方案。',
        profileAspect: 'judgment_preference',
        attributes: { preferenceKey: 'alignment.architecture.abstraction' }
      }),
      fixtureEntity({
        key: 'alignment:preference:abstract',
        name: '大型系统加强抽象',
        summary: '跨团队且独立发布的大型系统需要更强抽象。',
        profileAspect: 'judgment_preference',
        attributes: { preferenceKey: 'alignment.architecture.abstraction' }
      }),
      fixtureEntity({
        key: 'alignment:preference:one-off-coral',
        name: '一次性珊瑚色选择',
        summary: 'ONE-OFF-CORAL-119：只用于一次演示，不应成为长期偏好。',
        profileAspect: 'taste',
        status: 'pending',
        attributes: { preferenceKey: 'alignment.one-off.coral' }
      })
    ]
  }));

  return {
    parentInput,
    ids: {
      parent,
      hotel,
      flight,
      travel,
      unrelated,
      oldDecision,
      currentDecision
    },
    commonCandidates: {
      hotel: hotel.ids['alignment:hotel:retry-candidate'],
      flight: flight.ids['alignment:flight:retry-candidate'],
      travel: travel.ids['alignment:travel:retry-candidate']
    }
  };
}

async function runDeterministicCases(
  app,
  personalSpaceId,
  fixture,
  emptyWorkspaces
) {
  let lifecycleContext = null;
  await evaluateCase({
    id: 'LIFECYCLE-01',
    title: '任务入口解析项目并建立知识检查上下文',
    domain: 'agent-entry',
    expected: '入口解析 hotel-b，并返回不透明 taskContextToken。'
  }, async () => {
    lifecycleContext = await app.beginTaskContext({
      sessionId: `${FIXTURE_VERSION}:lifecycle`,
      projectPath: join(emptyWorkspaces, PROJECTS.hotel)
    });
    return {
      pass: lifecycleContext.context.personal_project_id === PROJECTS.hotel
        && /^fuli-task-/.test(lifecycleContext.task_context_token),
      observed: `项目=${lifecycleContext.context.personal_project_id ?? '无'}；` +
        `checkpoint_required=${lifecycleContext.checkpoint_required}。`,
      evidence: ['begin_task_context', 'directory_name']
    };
  });

  await evaluateCase({
    id: 'LIFECYCLE-02',
    title: '任务出口要求检查但不强制写知识',
    domain: 'agent-checkpoint',
    expected: '未检查时阻止结束；retain_nothing 后放行且不产生知识写入。'
  }, async () => {
    const sessionId = `${FIXTURE_VERSION}:lifecycle`;
    const before = app.verifyTaskCheckpoint({ sessionId });
    const checkpoint = await app.checkpointTaskKnowledge({
      taskContextToken: lifecycleContext.task_context_token,
      disposition: 'retain_nothing',
      reason: '合成生命周期探针没有产生可复用知识。'
    });
    const after = app.verifyTaskCheckpoint({ sessionId });
    return {
      pass: before.decision === 'block'
        && checkpoint.disposition === 'retain_nothing'
        && after.status === 'checkpointed'
        && after.decision === undefined,
      observed: `检查前=${before.decision ?? 'allow'}；` +
        `处置=${checkpoint.disposition}；检查后=${after.status}。`,
      evidence: ['verify_task_checkpoint → retain_nothing']
    };
  });

  await evaluateCase({
    id: 'SCOPE-01',
    title: '当前子项目先取本地知识，再取得父项目可继承知识',
    domain: 'inheritance',
    expected: '高阶搜索自动解析 hotel-b，同时命中本地截止规则和父项目公共 API 规则。'
  }, async () => {
    const result = await app.searchCurrentProjectKnowledge({
      projectPath: join(emptyWorkspaces, PROJECTS.hotel),
      queries: ['HOTEL-CUTOFF-2140', 'FULI-DEMO-ENVELOPE-v3'],
      includeHistorical: false,
      includePending: false,
      limitPerQuery: 20
    });
    const localItem = findItem(result.results[0], 'HOTEL-CUTOFF-2140');
    const inheritedItem = findItem(
      result.results[1],
      'FULI-DEMO-ENVELOPE-v3'
    );
    return {
      pass: result.personal_project_id === PROJECTS.hotel
        && localItem?.defined_project_id === PROJECTS.hotel
        && inheritedItem?.defined_project_id === PROJECTS.parent
        && inheritedItem?.inherited_from_project_id === PROJECTS.parent
        && inheritedItem?.scope_distance === 1
        && result.scope_policy.local_project_first === true,
      observed: `当前项目=${result.personal_project_id ?? '无'}；` +
        `本地=${localItem?.defined_project_id ?? '未命中'}；` +
        `父项=${inheritedItem?.defined_project_id ?? '未命中'}；` +
        `distance=${inheritedItem?.scope_distance ?? '无'}。`,
      evidence: inheritedItem
        ? ['HOTEL-CUTOFF-2140', 'FULI-DEMO-ENVELOPE-v3', 'hotel-b → platform-a']
        : []
    };
  });

  await evaluateCase({
    id: 'SCOPE-02',
    title: '父项目 local_only 知识不泄漏给子项目',
    domain: 'isolation',
    expected: 'hotel-b 不应命中 PARENT-LOCAL-931。'
  }, async () => {
    const result = await search(app, personalSpaceId, PROJECTS.hotel, 'PARENT-LOCAL-931');
    const leaked = Boolean(findItem(result, 'PARENT-LOCAL-931'));
    return {
      pass: !leaked,
      observed: leaked ? '检测到 local_only 泄漏。' : '子项目未获得父项目本地知识。',
      evidence: []
    };
  });

  await evaluateCase({
    id: 'SCOPE-03',
    title: '定向继承只进入被授权子项目',
    domain: 'selective-inheritance',
    expected: 'SELECTED-HOTEL-742 在 hotel-b 命中，在 flight-c 不命中。'
  }, async () => {
    const [hotelResult, flightResult] = await Promise.all([
      search(app, personalSpaceId, PROJECTS.hotel, 'SELECTED-HOTEL-742'),
      search(app, personalSpaceId, PROJECTS.flight, 'SELECTED-HOTEL-742')
    ]);
    const hotelItem = findItem(hotelResult, 'SELECTED-HOTEL-742');
    const flightItem = findItem(flightResult, 'SELECTED-HOTEL-742');
    return {
      pass: Boolean(hotelItem) && !flightItem,
      observed: `hotel-b=${Boolean(hotelItem)}，flight-c=${Boolean(flightItem)}。`,
      evidence: hotelItem ? ['selected_projects: hotel-b'] : []
    };
  });

  await evaluateCase({
    id: 'SCOPE-04',
    title: 'RELATED_TO 不扩张检索范围',
    domain: 'negative-control',
    expected: 'botany-e 不应获得 platform-a 的活动规则。'
  }, async () => {
    const result = await search(app, personalSpaceId, PROJECTS.unrelated, 'CANARY-7X18');
    const leaked = Boolean(findItem(result, 'CANARY-7X18'));
    return {
      pass: !leaked,
      observed: leaked ? '普通关联导致知识泄漏。' : '普通关联未扩张检索范围。',
      evidence: ['botany-e RELATED_TO platform-a']
    };
  });

  await evaluateCase({
    id: 'SCOPE-05',
    title: '子项目同稳定键规则覆盖父项目',
    domain: 'override',
    expected: 'hotel-b 只采用 45 seconds，不采用父项目 180 seconds。'
  }, async () => {
    const result = await search(app, personalSpaceId, PROJECTS.hotel, '缓存 seconds');
    const candidates = result.entities.filter(({ key }) => key === 'shared.cache.ttl');
    const summary = candidates.map(({ summary }) => summary).join(' | ');
    return {
      pass: candidates.length === 1
        && summary.includes('45 seconds')
        && !summary.includes('180 seconds'),
      observed: candidates.length
        ? `同键候选数=${candidates.length}；采用 ${summary}`
        : '未命中缓存规则。',
      evidence: candidates.length ? ['shared.cache.ttl'] : []
    };
  });

  await evaluateCase({
    id: 'SCOPE-06',
    title: '包含多个项目的工作区根目录不会被猜测',
    domain: 'path-ambiguity',
    expected: '从合成工作区根目录搜索时返回 ambiguous，不执行项目知识搜索。'
  }, async () => {
    const result = await app.searchCurrentProjectKnowledge({
      projectPath: emptyWorkspaces,
      queries: ['how to run locally'],
      includeHistorical: false,
      includePending: false
    });
    return {
      pass: result.status === 'project_unresolved'
        && result.project_resolution.status === 'ambiguous'
        && result.results.length === 0,
      observed: `状态=${result.status}；` +
        `解析=${result.project_resolution.status}；搜索数=${result.results.length}。`,
      evidence: ['ambiguous paths never guess']
    };
  });

  await evaluateCase({
    id: 'TIME-01',
    title: '现行决定与被替代历史可区分',
    domain: 'knowledge-update',
    expected: '默认检索只返回 STATE-LOCAL-912；历史检索同时返回 Redux 旧决定。'
  }, async () => {
    const [current, historical] = await Promise.all([
      search(
        app,
        personalSpaceId,
        PROJECTS.parent,
        'STATE-REDUX-411 STATE-LOCAL-912',
        { includeHistorical: false }
      ),
      search(
        app,
        personalSpaceId,
        PROJECTS.parent,
        'STATE-REDUX-411 STATE-LOCAL-912',
        { includeHistorical: true }
      )
    ]);
    const currentText = allText(current);
    const historicalText = allText(historical);
    return {
      pass: currentText.includes('STATE-LOCAL-912')
        && !currentText.includes('STATE-REDUX-411')
        && historicalText.includes('STATE-LOCAL-912')
        && historicalText.includes('STATE-REDUX-411'),
      observed: `当前=[${markers(currentText, ['STATE-LOCAL-912', 'STATE-REDUX-411']).join(', ')}]；` +
        `历史=[${markers(historicalText, ['STATE-LOCAL-912', 'STATE-REDUX-411']).join(', ')}]。`,
      evidence: ['STATE-REDUX-411 → STATE-LOCAL-912']
    };
  });

  await evaluateCase({
    id: 'DECISION-01',
    title: '决策结论、备选项、理由和验证结果形成可检索链',
    domain: 'decision-rationale',
    expected: 'Decision、DecisionOption、DecisionRationale、ValidationResult 及四类关系完整存在。'
  }, async () => {
    await app.recordDecisionTrace({
      personalSpaceId,
      personalProjectId: PROJECTS.parent,
      sessionId: `${FIXTURE_VERSION}:decision-trace`,
      idempotencyKey: `${FIXTURE_VERSION}:decision-trace:agent-enforcement`,
      decisionKey: 'agent-enforcement',
      title: 'Agent 知识检查执行方式（合成）',
      question: '如何确保任务结束前完成知识价值检查？',
      selectedOption: {
        key: 'lifecycle-hook',
        label: '生命周期 Hook',
        summary: '入口加载上下文，出口检查 checkpoint。'
      },
      rejectedOptions: [{
        key: 'prompt-only',
        label: '只依赖 Prompt',
        summary: '模型可能跳过自愿工具调用。'
      }],
      reason: 'DECISION-REASON-448：生命周期 Hook 降低对模型自愿选工具的依赖。',
      validationResults: [{
        key: 'provider-test',
        outcome: 'pass',
        summary: '合成 Provider 测试验证未 checkpoint 时阻止结束。'
      }],
      decidedBy: { kind: 'user', label: 'synthetic benchmark operator' },
      referenceTime: REFERENCE_TIME,
      sourceKind: 'synthetic_acceptance_fixture',
      sourceDescription: 'Benchmark v2 显式给出的合成决策及理由。',
      sourceApplication: 'other',
      sourceTurnId: `${FIXTURE_VERSION}:decision-trace`,
      sensitivity: 'private'
    });
    const graph = await app.getKnowledgeGraph({
      spaceId: personalSpaceId,
      personalProjectId: PROJECTS.parent,
      limit: 1000
    });
    const nodeTypes = new Set(graph.nodes.map(({ type }) => type));
    const relationTypes = new Set(graph.edges.map(({ type }) => type));
    const rationale = graph.nodes.find(
      ({ type, summary }) =>
        type === 'DecisionRationale'
        && summary.includes('DECISION-REASON-448')
    );
    const expectedNodes = [
      'Decision', 'DecisionOption', 'DecisionRationale', 'ValidationResult'
    ];
    const expectedRelations = [
      'SELECTED_OPTION', 'REJECTED_OPTION', 'MOTIVATED_BY', 'VALIDATED_BY'
    ];
    return {
      pass: expectedNodes.every((type) => nodeTypes.has(type))
        && expectedRelations.every((type) => relationTypes.has(type))
        && rationale?.confirmation_status === 'confirmed',
      observed: `节点=${expectedNodes.filter((type) => nodeTypes.has(type)).join(', ')}；` +
        `关系=${expectedRelations.filter((type) => relationTypes.has(type)).join(', ')}。`,
      evidence: rationale ? ['DECISION-REASON-448', 'human-confirmed'] : []
    };
  });

  await evaluateCase({
    id: 'FEEDBACK-01',
    title: '负面证据降权但不越过人工确认权威',
    domain: 'negative-evidence',
    expected: '验证失败事件幂等记录，requires_attention=true，人工 confirmed 保持不变。'
  }, async () => {
    const itemId = fixture.ids.parent.ids['alignment:feedback:validation'];
    const feedback = await app.recordKnowledgeFeedback({
      personalSpaceId,
      taskId: `${FIXTURE_VERSION}:feedback-task`,
      sessionId: `${FIXTURE_VERSION}:feedback-session`,
      toolName: 'alignment_runner',
      items: [{
        itemId,
        itemKind: 'entity',
        feedbackKind: 'validation_failed',
        reason: '合成验证命令返回失败。',
        evidenceSummary: 'Synthetic fixture: exit code 1; no production command ran.',
        reportedByKind: 'agent'
      }]
    });
    const replay = await app.recordKnowledgeFeedback({
      personalSpaceId,
      taskId: `${FIXTURE_VERSION}:feedback-task`,
      sessionId: `${FIXTURE_VERSION}:feedback-session`,
      toolName: 'alignment_runner',
      items: [{
        itemId,
        itemKind: 'entity',
        feedbackKind: 'validation_failed',
        reason: '合成验证命令返回失败。',
        evidenceSummary: 'Synthetic fixture: exit code 1; no production command ran.',
        reportedByKind: 'agent'
      }]
    });
    const searched = await search(
      app,
      personalSpaceId,
      PROJECTS.parent,
      'FEEDBACK-CHECK-662'
    );
    const item = findItem(searched, 'FEEDBACK-CHECK-662');
    return {
      pass: feedback.recorded_count === 1
        && replay.duplicate_count === 1
        && item?.confirmation_status === 'confirmed'
        && item?.requires_attention === true
        && item?.negative_evidence_count === 1,
      observed: `首次=${feedback.recorded_count}；重放重复=${replay.duplicate_count}；` +
        `status=${item?.confirmation_status ?? '无'}；` +
        `attention=${item?.requires_attention ?? '无'}；` +
        `negative=${item?.negative_evidence_count ?? '无'}。`,
      evidence: item ? ['validation_failed', 'authority preserved'] : []
    };
  });

  await evaluateCase({
    id: 'CONFLICT-01',
    title: '同权威偏好冲突不自动注入',
    domain: 'conflict',
    expected: '两条 architecture.abstraction 偏好进入冲突，不进入 effective_preferences。'
  }, async () => {
    const result = await app.getCollaborationPreferences({
      personalProjectId: PROJECTS.parent
    });
    const conflict = (result.conflicts ?? []).find(
      ({ preference_key: key }) => key === 'alignment.architecture.abstraction'
    );
    const injected = (result.effective_preferences ?? []).some(
      ({ preference_key: key }) => key === 'alignment.architecture.abstraction'
    );
    return {
      pass: Boolean(conflict) && !injected,
      observed: `conflict=${Boolean(conflict)}，effective=${injected}。`,
      evidence: conflict ? ['冲突双方均被保留，未静默选边'] : []
    };
  });

  await evaluateCase({
    id: 'POLLUTION-01',
    title: '一次性待确认偏好保持按需搜索',
    domain: 'memory-pollution',
    expected: 'ONE-OFF-CORAL-119 不自动注入；includePending=true 时可检索。'
  }, async () => {
    const [preferences, defaultSearch, pendingSearch] = await Promise.all([
      app.getCollaborationPreferences({ personalProjectId: PROJECTS.hotel }),
      search(
        app,
        personalSpaceId,
        PROJECTS.hotel,
        'ONE-OFF-CORAL-119',
        { includePending: false }
      ),
      search(
        app,
        personalSpaceId,
        PROJECTS.hotel,
        'ONE-OFF-CORAL-119',
        { includePending: true }
      )
    ]);
    const injected = (preferences.effective_preferences ?? []).some(
      ({ preference_key: key }) => key === 'alignment.one-off.coral'
    );
    const defaultHit = Boolean(findItem(defaultSearch, 'ONE-OFF-CORAL-119'));
    const pendingHit = Boolean(findItem(pendingSearch, 'ONE-OFF-CORAL-119'));
    return {
      pass: !injected && !defaultHit && pendingHit,
      observed: `effective=${injected}，默认检索=${defaultHit}，待确认检索=${pendingHit}。`,
      evidence: pendingHit ? ['pending/search-only'] : []
    };
  });

  await evaluateCase({
    id: 'IDEMPOTENCY-01',
    title: '相同 Episode 重放不产生重复知识',
    domain: 'duplicate-control',
    expected: '第二次提交返回 duplicate，实体 ID 保持一致。'
  }, async () => {
    const replay = await app.captureSessionKnowledge(fixture.parentInput);
    const originalIds = fixture.ids.parent.result.entity_ids;
    return {
      pass: replay.status === 'duplicate'
        && JSON.stringify(replay.entity_ids) === JSON.stringify(originalIds),
      observed: `重放状态=${replay.status}；实体数量=${replay.entity_ids.length}。`,
      evidence: ['idempotency_key stable']
    };
  });

  await evaluateCase({
    id: 'CONVERGE-01',
    title: '直接子项目公共候选只读发现',
    domain: 'common-candidate-discovery',
    expected: '发现 B/C/D 的共同候选，不把继承或个人全局知识混入，也不自动写入 A。'
  }, async () => {
    const before = await search(
      app,
      personalSpaceId,
      PROJECTS.parent,
      COMMON_RETRY_MARKER
    );
    const result = await app.discoverCommonKnowledgeCandidates({
      personalSpaceId,
      parentProjectId: PROJECTS.parent,
      query: `${COMMON_RETRY_MARKER} 2 attempts 140ms jitter`,
      minChildProjects: 3,
      similarityThreshold: 0.4,
      limitPerProject: 20
    });
    const after = await search(
      app,
      personalSpaceId,
      PROJECTS.parent,
      COMMON_RETRY_MARKER
    );
    const candidate = result.candidates[0];
    return {
      pass: result.status === 'candidates_found'
        && candidate?.requires_human_confirmation === true
        && candidate?.promotion_performed === false
        && [PROJECTS.hotel, PROJECTS.flight, PROJECTS.travel]
          .every((projectId) => candidate.child_project_ids.includes(projectId))
        && !findItem(before, COMMON_RETRY_MARKER)
        && !findItem(after, COMMON_RETRY_MARKER),
      observed: `状态=${result.status}；候选=${result.candidates.length}；` +
        `来源=${candidate?.child_project_ids.join(', ') ?? '无'}；` +
        `父项目写入=${Boolean(findItem(after, COMMON_RETRY_MARKER))}。`,
      evidence: candidate
        ? ['read_only', 'direct PART_OF children', 'human confirmation required']
        : []
    };
  });

  await evaluateCase({
    id: 'CONVERGE-READ-01',
    title: '候选发现排除继承结果与个人全局知识',
    domain: 'candidate-isolation',
    expected: '候选策略明确关闭继承和个人全局注入。'
  }, async () => {
    const result = await app.discoverCommonKnowledgeCandidates({
      personalSpaceId,
      parentProjectId: PROJECTS.parent,
      query: `${COMMON_RETRY_MARKER} retry`,
      minChildProjects: 3,
      similarityThreshold: 0.4,
      limitPerProject: 20
    });
    return {
      pass: result.policy.inherited_knowledge_excluded === true
        && result.policy.personal_global_excluded === true
        && result.policy.automatic_promotion === false,
      observed: `inherit_excluded=${result.policy.inherited_knowledge_excluded}；` +
        `global_excluded=${result.policy.personal_global_excluded}；` +
        `automatic=${result.policy.automatic_promotion}。`,
      evidence: ['candidate policy']
    };
  });
}

async function runClaudeCases({
  app,
  personalSpaceId,
  fixtureWorkspaces,
  emptyWorkspaces,
  mcpConfigPath,
  claudeSettingsPath,
  lifecycleAuditPath
}) {
  const version = await tryRunProcess('claude', ['--version'], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 30_000
  });
  benchmark.run.claude.version = version.ok
    ? version.stdout.trim().slice(0, 120)
    : 'unavailable';

  const installedMcp = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  const installedSettings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
  const hasEntryHook = JSON.stringify(
    installedSettings.hooks?.UserPromptSubmit ?? []
  ).includes('begin_task_context');
  const hasStopHook = JSON.stringify(
    installedSettings.hooks?.Stop ?? []
  ).includes('verify_task_checkpoint');
  addCase({
    id: 'AGENT-00',
    title: 'Claude 安装态启用 alwaysLoad 与双生命周期 Hook',
    domain: 'claude-lifecycle-config',
    status: installedMcp.mcpServers?.fuli?.alwaysLoad === true
      && hasEntryHook
      && hasStopHook
      ? 'PASS' : 'FAIL',
    expected: 'Fuli alwaysLoad，UserPromptSubmit 调 begin，Stop 调 verify。',
    observed: `alwaysLoad=${installedMcp.mcpServers?.fuli?.alwaysLoad === true}；` +
      `entry=${hasEntryHook}；stop=${hasStopHook}。`,
    evidence: ['production connector generated isolated config']
  });

  const capturePrompt = [
    '这是一次隔离的合成验收。所有文档都明确标为虚构，不是生产事实。',
    'Fuli 生命周期 Hook 会在模型工作前注入任务上下文；应用其中的有效偏好。',
    '只读取 06-agent-capture.md。把其中唯一的会员加赠窗口事实写入当前 personal space',
    '的 hotel-b 项目，稳定键必须是 alignment:hotel:loyalty-window，名称为 酒店会员加赠窗口。',
    '这是由 Agent 从合成源提取的知识。capture_session_knowledge 使用下面的完整字段约束：',
    `idempotencyKey=${FIXTURE_VERSION}:claude:capture；sessionId=alignment-claude-capture；`,
    'name=酒店会员加赠窗口合成捕获；sourceKind=synthetic_acceptance_fixture；',
    'sourceDescription=合成验收源明确给出的酒店会员加赠窗口；',
    'sourceApplication=claude_code；referenceTime=2026-07-31T00:00:00.000Z；',
    'summary=只捕获一个合成酒店事实；sensitivity=private；relationships=[]。',
    'entities 只含一个对象：key=alignment:hotel:loyalty-window；name=酒店会员加赠窗口；',
    'type=ProjectKnowledge；summary=LOYALTY-WINDOW-503：会员加赠窗口从入住日前 36 hours 开始；',
    'originQuadrant=known_known；currentQuadrant=known_known；epistemicStatus=observed；',
    'confirmationStatus=pending；reasoningSummary=null；profileAspect=null；',
    'inheritanceMode=local_only；inheritedProjectIds=[]；attributes.fixture=synthetic。',
    'confirmationBasis 必须完整包含：existenceReason=合成验收源直接陈述；',
    'quadrantReason=文档中明确给出；proposedBy={kind:agent,label:Claude Code acceptance}；',
    'confirmedBy=null；confirmedAt=null；agentPolicyVersion=null。',
    'targetKind=personal；spaceId 使用 Hook 上下文中的 personal_space_id；personalProjectId=hotel-b。',
    '不要写入其他知识，不要修改文件。结束前用 Hook 返回的 taskContextToken 调用',
    'checkpoint_task_knowledge，选择 retain_nothing，并说明显式捕获已完成、没有额外候选。',
    '最后只说明捕获是否成功。'
  ].join('\n');
  const captureRun = await runClaude({
    prompt: capturePrompt,
    cwd: join(fixtureWorkspaces, PROJECTS.hotel),
    mcpConfigPath,
    settingsPath: claudeSettingsPath,
    lifecycleAuditPath,
    enforceFuliStart: true,
    builtInTools: ['Read'],
    allowedTools: [
      'Read',
      'mcp__fuli__capture_session_knowledge',
      'mcp__fuli__checkpoint_task_knowledge'
    ]
  });
  recordClaudeMetrics(captureRun);
  const checkpointCalled = captureRun.toolCalls.some(
    ({ name }) => name === 'mcp__fuli__checkpoint_task_knowledge'
  );
  addCase({
    id: 'AGENT-01',
    title: 'Claude Code 入口与出口 Hook 在真实任务中执行',
    domain: 'claude-lifecycle-hooks',
    status: classifyClaudeCaseStatus({
      errors: [captureRun.error],
      passed: !captureRun.error
      && captureRun.hookSignals.userPromptSubmit
      && captureRun.hookSignals.beginTaskContext
      && captureRun.hookSignals.stop
      && captureRun.hookSignals.verifyTaskCheckpoint
      && checkpointCalled
    }),
    expected: '入口 Hook 调 begin，出口 Hook 调 verify，模型完成一次 checkpoint。',
    observed: captureRun.error
      ? `Claude 调用失败：${captureRun.error}`
      : `entry=${captureRun.hookSignals.userPromptSubmit}/` +
        `${captureRun.hookSignals.beginTaskContext}；` +
        `stop=${captureRun.hookSignals.stop}/` +
        `${captureRun.hookSignals.verifyTaskCheckpoint}；` +
        `checkpoint=${checkpointCalled}。`,
    evidence: [
      ...captureRun.toolCalls.map(({ name }) => name),
      'hook signals are boolean-only; raw hook payloads are discarded'
    ]
  });

  const capturedSearch = await search(
    app,
    personalSpaceId,
    PROJECTS.hotel,
    CLAUDE_CAPTURE_MARKER,
    { includePending: true }
  );
  const capturedItem = findItem(capturedSearch, CLAUDE_CAPTURE_MARKER);
  const captureToolCalled = captureRun.toolCalls.some(
    ({ name }) => name === 'mcp__fuli__capture_session_knowledge'
  );
  addCase({
    id: 'AGENT-02',
    title: 'Claude Code 通过 Fuli 沉淀源文档事实',
    domain: 'claude-capture',
    status: classifyClaudeCaseStatus({
      errors: [captureRun.error],
      passed: !captureRun.error && captureToolCalled && Boolean(capturedItem)
    }),
    expected: `${CLAUDE_CAPTURE_MARKER} 由 Claude Code 以 pending 写入 hotel-b，且可按需检索。`,
    observed: captureRun.error
      ? `Claude 调用失败：${captureRun.error}`
      : `capture_tool=${captureToolCalled}，graph_hit=${Boolean(capturedItem)}，` +
        `confirmation=${capturedItem?.confirmation_status ?? '无'}。`,
    evidence: capturedItem ? [
      CLAUDE_CAPTURE_MARKER,
      `defined_project_id=${capturedItem.defined_project_id}`
    ] : captureRun.toolResults
      .filter(({ name }) => name === 'mcp__fuli__capture_session_knowledge')
      .map(({ summary }) => summary)
  });

  if (isClaudeInfrastructureError(captureRun.error)) {
    addClaudeInfrastructureBlockedCases(captureRun.error);
    return;
  }

  const comparisonPrompt = [
    '你在一个空的 hotel-b 工作区里，不能读取任何项目文档。',
    'Fuli 生命周期 Hook 会提供任务上下文。实际调用 search_current_project_knowledge，',
    'projectPath 使用当前工作目录，queries 精确包含以下五项：',
    '“公共 API 响应封装”、“公共 Mock 可恢复故障”、“公共部署门禁”、',
    '“酒店取消截止”、“酒店会员加赠窗口”。不要手抄 personal space 或 project ID。',
    '请给出以下五项当前规则及其稳定标记：',
    '1. 公共 API 响应封装；2. 公共 Mock 的可恢复故障；3. 公共部署门禁；',
    '4. 酒店取消截止；5. 酒店会员加赠窗口。',
    '不要猜测；证据不足的项目明确写“未知”。结束前完成知识 checkpoint，',
    '本任务没有新增知识时使用 retain_nothing。回答保持简短。'
  ].join('\n');
  const baselineRun = await runClaude({
    prompt: comparisonPrompt,
    cwd: join(emptyWorkspaces, PROJECTS.hotel),
    safeMode: true,
    builtInTools: []
  });
  recordClaudeMetrics(baselineRun);
  const fuliRun = await runClaude({
    prompt: comparisonPrompt,
    cwd: join(emptyWorkspaces, PROJECTS.hotel),
    mcpConfigPath,
    settingsPath: claudeSettingsPath,
    lifecycleAuditPath,
    enforceFuliStart: true,
    builtInTools: [],
    allowedTools: [
      'mcp__fuli__search_current_project_knowledge',
      'mcp__fuli__record_knowledge_usage',
      'mcp__fuli__checkpoint_task_knowledge'
    ]
  });
  recordClaudeMetrics(fuliRun);

  const comparisonMarkers = [
    'FULI-DEMO-ENVELOPE-v3',
    'SIM-4187',
    'CANARY-7X18',
    'HOTEL-CUTOFF-2140',
    CLAUDE_CAPTURE_MARKER
  ];
  const baselineMarkers = markers(baselineRun.answer, comparisonMarkers);
  const fuliMarkers = markers(fuliRun.answer, comparisonMarkers);
  const fuliSearched = fuliRun.toolCalls.some(
    ({ name }) => name === 'mcp__fuli__search_current_project_knowledge'
  );
  addCase({
    id: 'AGENT-03',
    title: '全新 Claude 会话检索已沉淀知识',
    domain: 'fresh-session-retrieval',
    status: classifyClaudeCaseStatus({
      errors: [fuliRun.error],
      passed: !fuliRun.error
      && fuliRun.hookSignals.beginTaskContext
      && fuliSearched
      && fuliMarkers.includes(CLAUDE_CAPTURE_MARKER)
    }),
    expected: '非持久化新会话由 Hook 加载上下文，高阶搜索检索此前捕获的会员窗口。',
    observed: fuliRun.error
      ? `Claude 调用失败：${fuliRun.error}`
      : `entry_hook=${fuliRun.hookSignals.beginTaskContext}；` +
        `命中标记=${fuliMarkers.join(', ') || '无'}。`,
    evidence: fuliRun.toolCalls.map(({ name }) => name)
  });
  addCase({
    id: 'AGENT-04',
    title: '无 Fuli / 有 Fuli 冷启动对照',
    domain: 'cold-start-ab',
    status: classifyClaudeCaseStatus({
      errors: [baselineRun.error, fuliRun.error],
      passed: !baselineRun.error
      && !fuliRun.error
      && fuliMarkers.length >= 4
      && fuliMarkers.length > baselineMarkers.length
      && baselineMarkers.length === 0
    }),
    expected: '同模型同提示下，无 Fuli 不猜中稳定标记；有 Fuli 至少恢复 4/5。',
    observed: baselineRun.error || fuliRun.error
      ? `调用错误：baseline=${baselineRun.error ?? 'none'}；fuli=${fuliRun.error ?? 'none'}。`
      : `baseline=${baselineMarkers.length}/5；fuli=${fuliMarkers.length}/5。`,
    evidence: [
      `baseline markers: ${baselineMarkers.join(', ') || 'none'}`,
      `fuli markers: ${fuliMarkers.join(', ') || 'none'}`
    ],
    metrics: {
      benchmarkTier: 'single_pair_smoke_only',
      pairedTaskCount: 1,
      promptCharacters: comparisonPrompt.length,
      baseline: {
        exactMarkerRecall: baselineMarkers.length / comparisonMarkers.length,
        durationMs: baselineRun.durationMs,
        costUsd: roundMoney(baselineRun.totalCostUsd),
        toolCallCount: baselineRun.toolCalls.length,
        answerHash: baselineRun.answerHash
      },
      fuli: {
        exactMarkerRecall: fuliMarkers.length / comparisonMarkers.length,
        durationMs: fuliRun.durationMs,
        costUsd: roundMoney(fuliRun.totalCostUsd),
        toolCallCount: fuliRun.toolCalls.length,
        answerHash: fuliRun.answerHash
      },
      userCorrectionRounds: {
        baseline: 0,
        fuli: 0,
        note: 'One-shot synthetic task; not evidence of long-term reduction.'
      }
    }
  });

  const unrelatedPrompt = [
    '你在 botany-e 项目中。请查证这个项目的活动平台 API 响应封装和酒店取消截止稳定标记。',
    '不要把 RELATED_TO 当作继承，也不要在未获确认时扩大到全部本地项目。',
    '调用 search_current_project_knowledge，projectPath 使用当前工作目录。',
    '如果当前有界知识不支持，明确写“无支持证据”，不要猜。结束前使用 retain_nothing checkpoint。'
  ].join('\n');
  const unrelatedRun = await runClaude({
    prompt: unrelatedPrompt,
    cwd: join(emptyWorkspaces, PROJECTS.unrelated),
    mcpConfigPath,
    settingsPath: claudeSettingsPath,
    lifecycleAuditPath,
    enforceFuliStart: true,
    builtInTools: [],
    allowedTools: [
      'mcp__fuli__search_current_project_knowledge',
      'mcp__fuli__checkpoint_task_knowledge'
    ]
  });
  recordClaudeMetrics(unrelatedRun);
  const leakedMarkers = markers(unrelatedRun.answer, [
    'FULI-DEMO-ENVELOPE-v3',
    'HOTEL-CUTOFF-2140',
    'SIM-4187',
    'CANARY-7X18'
  ]);
  const unrelatedSearch = unrelatedRun.toolCalls.find(
    ({ name }) => name === 'mcp__fuli__search_current_project_knowledge'
  );
  const widened = Boolean(
    unrelatedSearch?.input?.personalProjectScope === 'all_local_confirmed'
    || (unrelatedSearch?.input?.contextPersonalProjectIds?.length ?? 0) > 0
  );
  addCase({
    id: 'AGENT-05',
    title: 'Claude 对无关项目保持拒答与作用域边界',
    domain: 'agent-negative-control',
    status: classifyClaudeCaseStatus({
      errors: [unrelatedRun.error],
      passed: !unrelatedRun.error
      && unrelatedRun.hookSignals.beginTaskContext
      && Boolean(unrelatedSearch)
      && leakedMarkers.length === 0
      && !widened
    }),
    expected: 'botany-e 不泄漏平台或酒店标记，也不擅自扩大检索范围。',
    observed: unrelatedRun.error
      ? `Claude 调用失败：${unrelatedRun.error}`
      : `泄漏标记=${leakedMarkers.join(', ') || '无'}；擅自扩张=${widened}。`,
    evidence: unrelatedRun.toolCalls.map(({ name }) => name)
  });

  const convergencePrompt = [
    '这是一次只读的公共知识候选分析，不授权任何写入。',
    '必须实际调用 discover_common_knowledge_candidates：parentProjectId=platform-a，',
    'query=“2 attempts 140ms jitter”，minChildProjects=3，similarityThreshold=0.4。',
    '指出共同标记、来源项目、相似度只是推断，以及为什么仍需人工确认。',
    '结束前使用 retain_nothing checkpoint；只返回证据支持的结论。'
  ].join('\n');
  const convergenceRun = await runClaude({
    prompt: convergencePrompt,
    cwd: join(emptyWorkspaces, PROJECTS.parent),
    mcpConfigPath,
    settingsPath: claudeSettingsPath,
    lifecycleAuditPath,
    enforceFuliStart: true,
    builtInTools: [],
    allowedTools: [
      'mcp__fuli__discover_common_knowledge_candidates',
      'mcp__fuli__checkpoint_task_knowledge'
    ]
  });
  recordClaudeMetrics(convergenceRun);
  const convergenceSearch = convergenceRun.toolCalls.find(
    ({ name }) => name === 'mcp__fuli__discover_common_knowledge_candidates'
  );
  const answerHasProjects = [PROJECTS.hotel, PROJECTS.flight, PROJECTS.travel]
    .every((projectId) => convergenceRun.answer.includes(projectId));
  addCase({
    id: 'AGENT-06',
    title: 'Claude 显式跨子项目识别公共候选',
    domain: 'cross-project-analysis',
    status: classifyClaudeCaseStatus({
      errors: [convergenceRun.error],
      passed: !convergenceRun.error
      && convergenceRun.answer.includes(COMMON_RETRY_MARKER)
      && answerHasProjects
      && convergenceSearch?.input?.parentProjectId === PROJECTS.parent
    }),
    expected: 'Claude 只读选择 B/C/D，识别共同重试规则，并说明尚未自动归属 A。',
    observed: convergenceRun.error
      ? `Claude 调用失败：${convergenceRun.error}`
      : `回答含共同标记=${convergenceRun.answer.includes(COMMON_RETRY_MARKER)}；` +
        `回答含三项目=${answerHasProjects}；` +
        `父项目=${convergenceSearch?.input?.parentProjectId ?? '无'}。`,
    evidence: convergenceRun.toolCalls.map(({ name }) => name)
  });
}

async function runCuratedConvergenceCase(app, personalSpaceId, fixture) {
  await evaluateCase({
    id: 'CONVERGE-02',
    title: '人工确认预览绑定公共知识上收意图',
    domain: 'common-promotion-preview',
    expected: '预览校验不同直接子项目、规范项、重复项和两类理由，不产生写入。'
  }, async () => {
    const canonicalId = fixture.commonCandidates.hotel;
    const preview = await app.previewCommonKnowledgePromotion({
      personalSpaceId,
      parentProjectId: PROJECTS.parent,
      itemKind: 'entity',
      canonicalItemId: canonicalId,
      duplicateItemIds: [
        fixture.commonCandidates.flight,
        fixture.commonCandidates.travel
      ],
      reason: '三个子项目的合成证据一致，将公共重试规则显式归属父项目。',
      humanConfirmationReason: '合成 Benchmark 明确授权本次精确的上收预览。'
    });
    const parentBefore = await search(
      app,
      personalSpaceId,
      PROJECTS.parent,
      COMMON_RETRY_MARKER
    );
    return {
      pass: preview.status === 'ready'
        && preview.atomic === true
        && preview.requires_human_confirmation === true
        && preview.source_project_ids.length === 3
        && !findItem(parentBefore, COMMON_RETRY_MARKER),
      observed: `状态=${preview.status}；atomic=${preview.atomic}；` +
        `来源=${preview.source_project_ids.join(', ')}；写入=false。`,
      evidence: ['preview only', 'human confirmation reason bound']
    };
  });

  await evaluateCase({
    id: 'CONVERGE-03',
    title: '一次 Provider 原子操作完成父项目上收',
    domain: 'atomic-common-promotion',
    expected: '规范项归属 A 并允许后代继承，C/D 重复项失效且指向规范项。'
  }, async () => {
    const canonicalId = fixture.commonCandidates.hotel;
    const promotion = await app.applyCommonKnowledgePromotion({
      personalSpaceId,
      parentProjectId: PROJECTS.parent,
      itemKind: 'entity',
      canonicalItemId: canonicalId,
      duplicateItemIds: [
        fixture.commonCandidates.flight,
        fixture.commonCandidates.travel
      ],
      reason: '三个子项目的合成证据一致，将公共重试规则显式归属父项目。',
      humanConfirmationReason: '合成 Benchmark 明确授权本次精确的原子上收。',
      operationActor: 'agent'
    });
    const projectIds = [
      PROJECTS.parent,
      PROJECTS.hotel,
      PROJECTS.flight,
      PROJECTS.travel
    ];
    const results = await Promise.all(
      projectIds.map((projectId) =>
        search(app, personalSpaceId, projectId, COMMON_RETRY_MARKER)
      )
    );
    const activeItems = results.map((result) => findItem(result, COMMON_RETRY_MARKER));
    const uniqueIds = new Set(activeItems.filter(Boolean).map(({ id }) => id));
    const allDefinedAtParent = activeItems.every(
      (item) => item?.defined_project_id === PROJECTS.parent
    );
    return {
      pass: promotion.status === 'promoted'
        && promotion.invalidated_item_ids.length === 2
        && promotion.inheritance_mode === 'descendants'
        && activeItems.every(Boolean)
        && uniqueIds.size === 1
        && allDefinedAtParent,
      observed: `四个项目命中=${activeItems.filter(Boolean).length}/4；` +
        `活动知识项数量=${uniqueIds.size}；统一归属 A=${allDefinedAtParent}；` +
        `promotion=${promotion.promotion_id}。`,
      evidence: [
        'one Provider mutation',
        'assignment → descendants → invalidate/link replacement',
        'reason and human confirmation reason retained'
      ]
    };
  });
}

function captureInput({
  personalSpaceId,
  projectId,
  idempotencyKey,
  name,
  sourceDescription,
  entities,
  relationships = []
}) {
  return {
    targetKind: 'personal',
    spaceId: personalSpaceId,
    personalProjectId: projectId,
    idempotencyKey,
    sessionId: `${FIXTURE_VERSION}:seed-session`,
    name,
    sourceKind: 'synthetic_acceptance_fixture',
    sourceDescription,
    sourceApplication: 'other',
    referenceTime: REFERENCE_TIME,
    summary: '全部内容是虚构验收数据，只用于 Fuli 对齐测试。',
    sensitivity: 'private',
    entities,
    relationships
  };
}

function fixtureEntity({
  key,
  name,
  summary,
  inheritanceMode = 'local_only',
  inheritedProjectIds = [],
  profileAspect = null,
  status = 'confirmed',
  attributes = {}
}) {
  return {
    key,
    name,
    type: profileAspect ? 'Preference' : 'ProjectKnowledge',
    summary,
    originQuadrant: 'known_known',
    currentQuadrant: 'known_known',
    epistemicStatus: status === 'confirmed' ? 'confirmed' : 'observed',
    confirmationStatus: status,
    confirmationBasis: status === 'confirmed'
      ? confirmedBasis('合成验收规范明确给出该事实。')
      : pendingBasis('一次性合成对话只提供了待确认观察。'),
    reasoningSummary: null,
    profileAspect,
    inheritanceMode,
    inheritedProjectIds,
    attributes
  };
}

function fixtureRelationship({
  key,
  source,
  target,
  type,
  fact,
  validAt,
  supersedes = [],
  inheritanceMode = 'local_only'
}) {
  return {
    key,
    source,
    target,
    type,
    fact,
    validAt,
    invalidAt: null,
    supersedes,
    confidence: 1,
    originQuadrant: 'known_known',
    currentQuadrant: 'known_known',
    epistemicStatus: 'confirmed',
    confirmationStatus: 'confirmed',
    confirmationBasis: confirmedBasis('合成决策时间线明确给出该关系。'),
    reasoningSummary: null,
    profileAspect: null,
    inheritanceMode,
    inheritedProjectIds: [],
    attributes: {}
  };
}

function confirmedBasis(existenceReason) {
  return {
    existenceReason,
    quadrantReason: '该项目在合成验收源中被直接陈述。',
    proposedBy: { kind: 'agent', label: 'Fuli alignment harness' },
    confirmedBy: { kind: 'authoritative_source', label: 'Synthetic fixture specification' },
    confirmedAt: REFERENCE_TIME,
    agentPolicyVersion: null
  };
}

function pendingBasis(existenceReason) {
  return {
    existenceReason,
    quadrantReason: '该内容只在一次性合成会话中出现，尚未形成长期规则。',
    proposedBy: { kind: 'agent', label: 'Fuli alignment harness' },
    confirmedBy: null,
    confirmedAt: null,
    agentPolicyVersion: null
  };
}

async function capture(app, input) {
  const result = await app.captureSessionKnowledge(input);
  return {
    result,
    ids: Object.fromEntries(
      input.entities.map(({ key }, index) => [key, result.entity_ids[index]])
    )
  };
}

function upsertProject(app, personalSpaceId, projectId, profile) {
  return app.upsertPersonalProject({
    personalSpaceId,
    projectId,
    profile: {
      name: profile.name,
      purpose: profile.purpose,
      scope: profile.scope,
      technicalSummary: profile.technicalSummary,
      lifecycle: 'active',
      sources: profile.sources.map((source, index) => ({
        key: `fixture-${index + 1}`,
        kind: 'technical_document',
        title: source,
        uri: `acceptance/alignment/fixtures/${source}`,
        summary: '合成验收来源，不是生产事实。',
        sensitivity: 'private'
      })),
      boundaries: [
        '全部数据为合成验收夹具。',
        '不得发布为公共或生产知识。'
      ]
    }
  });
}

function relatePersonalProjects(
  app,
  personalSpaceId,
  sourceItemId,
  targetProjectId,
  relationType
) {
  return app.applyKnowledgeProjectAction({
    personalSpaceId,
    itemKind: 'entity',
    itemId: sourceItemId,
    mode: 'existing',
    targetProjectId,
    keepSourceRelation: true,
    relationType,
    conflictResolution: 'coexist',
    reason: `合成验收显式创建 ${relationType} 项目关系。`,
    operationActor: 'agent'
  });
}

function search(
  app,
  personalSpaceId,
  personalProjectId,
  query,
  { includeHistorical = false, includePending = false } = {}
) {
  return app.searchKnowledge({
    personalSpaceId,
    personalProjectId,
    query,
    limit: 50,
    includeHistorical,
    includePending
  });
}

async function evaluateCase(definition, operation) {
  try {
    const result = await operation();
    addCase({
      ...definition,
      status: result.pass ? 'PASS' : 'FAIL',
      observed: result.observed,
      evidence: result.evidence ?? [],
      metrics: result.metrics ?? null
    });
  } catch (error) {
    addCase({
      ...definition,
      status: 'ERROR',
      observed: sanitizeError(error),
      evidence: []
    });
  }
}

function addCase({
  id,
  title,
  domain,
  status,
  expected,
  observed,
  evidence = [],
  metrics = null,
  failureIsProductGap = false
}) {
  benchmark.cases.push({
    id,
    title,
    domain,
    status,
    expected,
    observed,
    evidence: evidence.map((value) => sanitizeText(String(value), 512)),
    metrics,
    failureIsProductGap
  });
  const symbol = status === 'PASS' ? '✓' : status === 'SKIP' ? '–' : '✗';
  process.stdout.write(`  ${symbol} ${id} ${title}: ${status}\n`);
}

function addSkippedClaudeCases() {
  for (const [id, title, domain] of [
    ['AGENT-00', 'Claude 安装态启用 alwaysLoad 与双生命周期 Hook', 'claude-lifecycle-config'],
    ['AGENT-01', 'Claude Code 入口与出口 Hook 在真实任务中执行', 'claude-lifecycle-hooks'],
    ['AGENT-02', 'Claude Code 通过 Fuli 沉淀源文档事实', 'claude-capture'],
    ['AGENT-03', '全新 Claude 会话检索已沉淀知识', 'fresh-session-retrieval'],
    ['AGENT-04', '无 Fuli / 有 Fuli 冷启动对照', 'cold-start-ab'],
    ['AGENT-05', 'Claude 对无关项目保持拒答与作用域边界', 'agent-negative-control'],
    ['AGENT-06', 'Claude 显式跨子项目识别公共候选', 'cross-project-analysis']
  ]) {
    addCase({
      id,
      title,
      domain,
      status: 'SKIP',
      expected: '运行真实 Claude Code 行为验收。',
      observed: '使用 --skip-claude 明确跳过。',
      evidence: []
    });
  }
}

function addClaudeInfrastructureBlockedCases(error) {
  for (const [id, title, domain] of [
    ['AGENT-03', '全新 Claude 会话检索已沉淀知识', 'fresh-session-retrieval'],
    ['AGENT-04', '无 Fuli / 有 Fuli 冷启动对照', 'cold-start-ab'],
    ['AGENT-05', 'Claude 对无关项目保持拒答与作用域边界', 'agent-negative-control'],
    ['AGENT-06', 'Claude 显式跨子项目识别公共候选', 'cross-project-analysis']
  ]) {
    addCase({
      id,
      title,
      domain,
      status: 'ERROR',
      expected: '运行真实 Claude Code 行为验收。',
      observed: `前置 Claude 探针发生外部基础设施错误，停止重复调用：${error}`,
      evidence: ['inference circuit breaker']
    });
  }
}

async function runClaude({
  prompt,
  cwd,
  mcpConfigPath = null,
  settingsPath = null,
  lifecycleAuditPath = null,
  safeMode = false,
  enforceFuliStart = true,
  builtInTools = [],
  allowedTools = []
}) {
  if (lifecycleAuditPath) {
    writeFileSync(lifecycleAuditPath, '', { encoding: 'utf8', mode: 0o600 });
  }
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--model', CLAUDE_MODEL,
    '--effort', CLAUDE_EFFORT,
    '--max-budget-usd', String(CLAUDE_BUDGET_USD),
    '--permission-mode', 'dontAsk',
    '--no-chrome',
    '--disable-slash-commands'
  ];
  if (settingsPath) {
    args.push('--settings', settingsPath, '--include-hook-events');
  }
  if (safeMode) {
    args.push('--safe-mode', '--tools', builtInTools.join(','));
  } else {
    args.push(
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config'
    );
    const disallowedTools = CLAUDE_BUILT_IN_TOOLS.filter(
      (toolName) => !builtInTools.includes(toolName)
    );
    if (disallowedTools.length) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }
    if (allowedTools.length) {
      args.push('--allowedTools', allowedTools.join(','));
    }
    if (enforceFuliStart) {
      args.push('--append-system-prompt', FULI_START_SYSTEM_PROMPT);
    }
  }
  const result = await tryRunProcess('claude', args, {
    cwd,
    timeoutMs: 4 * 60_000,
    maxOutputBytes: 8 * 1024 * 1024
  });
  const lifecycleAuditEvents = readLifecycleAudit(lifecycleAuditPath);
  if (!result.ok) {
    return {
      answer: '',
      answerHash: null,
      toolCalls: [],
      toolResults: [],
      hookSignals: hookSignals([], lifecycleAuditEvents),
      durationMs: result.durationMs,
      totalCostUsd: 0,
      error: summarizeClaudeExecutionError(result.error)
    };
  }
  return parseClaudeStream(
    result.stdout,
    result.durationMs,
    lifecycleAuditEvents
  );
}

function parseClaudeStream(stdout, measuredDurationMs, lifecycleAuditEvents = []) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Claude may emit a non-JSON diagnostic line; raw output is intentionally discarded.
    }
  }
  const toolCalls = [];
  const toolUseNames = new Map();
  const toolResults = [];
  const textBlocks = [];
  let resultEvent = null;
  for (const event of events) {
    if (event.type === 'result') resultEvent = event;
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name,
          input: block.input && typeof block.input === 'object' ? block.input : {}
        });
        toolUseNames.set(block.id, block.name);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        textBlocks.push(block.text);
      }
    }
  }
  for (const event of events) {
    if (event.type !== 'user' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const content = toolResultContent(block.content);
      toolResults.push({
        name: toolUseNames.get(block.tool_use_id) ?? 'unknown',
        isError: block.is_error === true,
        summary: sanitizeText(content, 700)
      });
    }
  }
  const answer = typeof resultEvent?.result === 'string'
    ? resultEvent.result
    : textBlocks.at(-1) ?? '';
  return {
    answer,
    answerHash: answer
      ? createHash('sha256').update(answer).digest('hex')
      : null,
    toolCalls,
    toolResults,
    hookSignals: hookSignals(events, lifecycleAuditEvents),
    durationMs: Number(resultEvent?.duration_ms ?? measuredDurationMs ?? 0),
    totalCostUsd: Number(resultEvent?.total_cost_usd ?? 0),
    error: resultEvent?.is_error
      ? summarizeClaudeExecutionError(
        resultEvent.result ?? 'Claude result reported an error.'
      )
      : null
  };
}

function hookSignals(events, lifecycleAuditEvents = []) {
  const hookEvents = events.filter((event) => {
    const type = String(event?.type ?? '');
    const subtype = String(event?.subtype ?? '');
    return /hook/i.test(type) || /hook/i.test(subtype);
  });
  const text = JSON.stringify(hookEvents);
  const began = lifecycleAuditEvents.includes('begin_task_context');
  const verified = lifecycleAuditEvents.includes('verify_task_checkpoint');
  return {
    userPromptSubmit: began || /UserPromptSubmit/i.test(text),
    beginTaskContext: began || /begin_task_context/i.test(text),
    stop: verified || /(?:^|[^A-Za-z])Stop(?:[^A-Za-z]|$)/i.test(text),
    verifyTaskCheckpoint: verified || /verify_task_checkpoint/i.test(text)
  };
}

function toolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((item) => (
    typeof item === 'string'
      ? item
      : typeof item?.text === 'string'
        ? item.text
        : JSON.stringify(item)
  )).join('\n');
}

function readLifecycleAudit(path) {
  if (!path) return [];
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

function recordClaudeMetrics(run) {
  benchmark.run.claude.calls += 1;
  benchmark.run.claude.totalDurationMs += Number(run.durationMs || 0);
  benchmark.run.claude.totalCostUsd = roundMoney(
    benchmark.run.claude.totalCostUsd + Number(run.totalCostUsd || 0)
  );
}

async function bootstrapProvider(providerUrl, bootstrapToken) {
  const response = await fetch(`${providerUrl}/v1/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fuli-bootstrap-token': bootstrapToken
    },
    body: JSON.stringify({ principal_name: 'Fuli alignment harness' })
  });
  if (!response.ok) throw new Error('Could not bootstrap isolated Fuli Provider');
  return response.json();
}

async function createPersonalSpace(providerUrl, accessToken) {
  const response = await fetch(`${providerUrl}/v1/spaces`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Fuli Alignment Synthetic Fixture',
      kind: 'personal'
    })
  });
  if (!response.ok) throw new Error('Could not create isolated personal space');
  return response.json();
}

async function waitForProvider(providerUrl) {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${providerUrl}/health`);
      if (response.ok) return;
    } catch {
      // Neo4j indices and the Provider may still be starting.
    }
    await delay(1000);
  }
  throw new Error('Isolated Fuli Provider did not become healthy in time');
}

async function cleanupRuntime() {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    let dockerVolumeRemoved = !state.composeAttempted;
    let temporaryRuntimeRemoved = !state.temporaryRoot;
    if (state.app) {
      try {
        await state.app.close();
      } catch {
        // Continue cleanup even if the provider connection already closed.
      }
      state.app = null;
    }
    for (const child of activeChildren) child.kill('SIGTERM');
    if (
      state.composeAttempted
      && state.composeProject
      && state.composeEnvironment
    ) {
      await tryRunProcess('docker', [
        'compose',
        '-p', state.composeProject,
        '-f', COMPOSE_PATH,
        'down', '--volumes', '--remove-orphans'
      ], {
        cwd: REPOSITORY_ROOT,
        env: state.composeEnvironment,
        timeoutMs: 2 * 60_000
      });
      let resources = await inspectComposeProjectResources();
      if (
        resources.ok
        && !composeResourcesRemoved(resources)
      ) {
        await removeComposeProjectResources(resources);
        resources = await inspectComposeProjectResources();
      }
      dockerVolumeRemoved = resources.ok
        && composeResourcesRemoved(resources);
      state.composeEnvironment = null;
    }
    if (state.temporaryRoot) {
      safeRemoveTemporaryDirectory(state.temporaryRoot);
      temporaryRuntimeRemoved = true;
      state.temporaryRoot = null;
    }
    return { dockerVolumeRemoved, temporaryRuntimeRemoved };
  })();
  return state.cleanupPromise;
}

async function inspectComposeProjectResources() {
  const filter = `label=com.docker.compose.project=${state.composeProject}`;
  const options = {
    cwd: REPOSITORY_ROOT,
    env: state.composeEnvironment,
    timeoutMs: 30_000
  };
  const [containers, networks, volumes] = await Promise.all([
    tryRunProcess('docker', [
      'container', 'ls', '--all', '--quiet', '--filter', filter
    ], options),
    tryRunProcess('docker', [
      'network', 'ls', '--quiet', '--filter', filter
    ], options),
    tryRunProcess('docker', [
      'volume', 'ls', '--quiet', '--filter', filter
    ], options)
  ]);
  return {
    ok: containers.ok && networks.ok && volumes.ok,
    containers: containers.stdout,
    networks: networks.stdout,
    volumes: volumes.stdout
  };
}

async function removeComposeProjectResources(resources) {
  const options = {
    cwd: REPOSITORY_ROOT,
    env: state.composeEnvironment,
    timeoutMs: 30_000
  };
  const containers = outputLines(resources.containers);
  const networks = outputLines(resources.networks);
  const volumes = outputLines(resources.volumes);
  if (containers.length) {
    await tryRunProcess('docker', [
      'container', 'rm', '--force', '--volumes', ...containers
    ], options);
  }
  if (networks.length) {
    await tryRunProcess('docker', [
      'network', 'rm', ...networks
    ], options);
  }
  if (volumes.length) {
    await tryRunProcess('docker', [
      'volume', 'rm', '--force', ...volumes
    ], options);
  }
}

function outputLines(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function installSignalHandlers() {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      void cleanupRuntime().finally(() => process.exit(code));
    });
  }
}

function safeRemoveTemporaryDirectory(path) {
  const resolvedPath = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  if (
    resolvedPath === resolvedTemp
    || !resolvedPath.startsWith(`${resolvedTemp}${sep}`)
    || !resolvedPath.includes('fuli-alignment-')
  ) {
    throw new Error('Refusing to remove a non-alignment temporary directory');
  }
  rmSync(resolvedPath, { recursive: true, force: true });
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  chmodSync(path, 0o600);
}

function writeOutputs(result) {
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(REPORT_PATH, renderReport(result), 'utf8');
}

function renderReport(result) {
  const counts = result.summary.counts;
  const infrastructure = result.cases.find(({ id }) => id === 'INFRA-01');
  const hookSmoke = readOptionalJson(HOOK_SMOKE_RESULT_PATH);
  const candidate = result.cases.find(({ id }) => id === 'CONVERGE-01');
  const preview = result.cases.find(({ id }) => id === 'CONVERGE-02');
  const atomic = result.cases.find(({ id }) => id === 'CONVERGE-03');
  const inheritance = result.cases.find(({ id }) => id === 'SCOPE-01');
  const lifecycle = result.cases.find(({ id }) => id === 'AGENT-01');
  const negative = result.cases.find(({ id }) => id === 'FEEDBACK-01');
  const coldStart = result.cases.find(({ id }) => id === 'AGENT-04');
  const capture = result.cases.find(({ id }) => id === 'AGENT-02');
  const rows = result.cases.map((item) =>
    `| ${item.id} | ${item.status} | ${escapeTable(item.observed)} |`
  ).join('\n');
  const executionSummary = infrastructure
    ? `本次尝试使用 ${result.run.fixtureDocumentCount} 份合成文档启动独立
Graphiti/Neo4j，但基础设施在语义用例和 Claude 调用前失败。`
    : `本报告使用 ${result.run.fixtureDocumentCount} 份合成文档、独立 Graphiti/Neo4j、
真实 Claude Code 与临时 Fuli MCP 运行。`;
  const lifecycleStatus = lifecycle?.status
    ?? (hookSmoke?.lifecyclePass
      ? 'PASS（轻量 Hook 协议烟测；完整图谱场景未执行）'
      : 'SKIP');
  const hookSmokeSection = hookSmoke
    ? `
## Supplemental Claude Code Hook Smoke

- 生命周期协议：${hookSmoke.lifecyclePass ? 'PASS' : 'FAIL'}
- 检索结果进入最终回答：${hookSmoke.retrievalAnswerPass ? 'PASS' : 'FAIL'}
- 入口 / checkpoint / Stop 标签：${
  ['begin_task_context', 'checkpoint_task_knowledge', 'verify_task_checkpoint']
    .every((event) => hookSmoke.auditEvents?.includes(event))
    ? '完整'
    : '不完整'
}
- 数据：完全合成；未保存原始 Claude 对话。

${hookSmoke.pass
    ? `该烟测使用生产 MCP 装配与真实 Claude Code，但使用内存假 Provider，
只能证明 Hook 协议链路，不能替代 Graphiti/Neo4j 完整验收。`
    : `该烟测未完成：入口 Hook 已触发，但真实 Claude 没有返回模型结果或执行后续工具，
因此不能把它解释为 Hook 产品失败，也不能给出 Hook 链路通过结论。`}
`
    : '';
  const overallLabel = (counts.ERROR ?? 0) > 0 && (counts.FAIL ?? 0) === 0
    ? `${result.summary.overall}（外部基础设施 ERROR；已执行的 Fuli 产品断言 0 FAIL）`
    : result.summary.overall;
  return `# Fuli × Claude Code Alignment Report

## Overall Result

**${overallLabel}**

${executionSummary}
合成内容不是生产事实，原始 Claude 对话、运行时配置和随机凭据均未保存。

结果统计：${counts.PASS ?? 0} PASS、${counts.FAIL ?? 0} FAIL、
${counts.ERROR ?? 0} ERROR、${counts.SKIP ?? 0} SKIP。

${(counts.ERROR ?? 0) > 0 && (counts.FAIL ?? 0) === 0
    ? `本轮 ERROR 共享同一个外部 Claude 推理网关故障；探针未进入模型与工具行为层，
所以它们不是六个独立的 Fuli 产品失败。`
    : ''}

## 直接回答

- **B/C/D 能否拿到 A 的知识：${inheritance?.status ?? 'UNKNOWN'}。**
  当前可以，但只限 \`PART_OF\` / \`USES_KNOWLEDGE_FROM\` 路径上、知识项显式授权为
  \`descendants\` 或 \`selected_projects\` 的内容。本地同稳定键规则优先。
- **公共候选是否只读发现：${candidate?.status ?? 'UNKNOWN'}。**
  相似内容只生成候选，不自动把“重复”推断成“公共规则”。
- **人工预览是否绑定精确意图：${preview?.status ?? 'UNKNOWN'}。**
- **是否可以原子上收：${atomic?.status ?? 'UNKNOWN'}。**
  规范项归属、向下继承、重复项失效、替代链接和理由在一个 Provider 事务内完成。
- **Claude Code 生命周期 Hook：${lifecycleStatus}。**
- **负面证据是否保持人工权威边界：${negative?.status ?? 'UNKNOWN'}。**
- **Claude Code 沉淀与全新会话复用：${capture?.status ?? 'SKIP'}。**
- **同提示冷启动 A/B：${coldStart?.status ?? 'SKIP'}。**
  ${coldStart?.observed ?? '未运行真实 Claude 对照。'}

## Benchmark Results

| Case | Result | Observation |
|---|---|---|
${rows}
${hookSmokeSection}

## Product Alignment Issues

1. **候选聚类仍是启发式。** 当前候选发现采用稳定键或词法重合；它适合生成待审候选，
   不足以单独判断领域语义等价。
2. **候选推荐尚未接入偏好与负向权重。** 用户拒绝一次公共化建议后，通用负面证据可以审计，
   但同一候选指纹的推荐排序和频率还不会自动降权；这里不需要新增独立 cooldown 状态机。
3. **语义相同不等于公共规则。** 三个项目碰巧使用相同参数，可能仍是领域巧合；必须人工确认，
   不能按相似度静默合并。
4. **行为样本量有限。** 单次 Claude 通过只能证明当前机器上的一次工具链行为；外部推理网关
   失败必须记为 ERROR，不能误记成 Fuli 产品 FAIL，也不能据此形成跨版本或长期结论。
5. **确定性生命周期目前只在 Claude Code 适配器完成。** 没有等价 Hook 的 Agent 仍是
   Prompt fallback，不能声明达到同一 Gate。
6. **A/B 仍是冒烟层。** 单次或五次行为样本只能说明趋势；Benchmark v2 要求至少 30 个配对任务
   才能形成产品结论。

## Recommended Common-Convergence Workflow

1. 为候选增加正文差异、确认权威、时间、使用次数、冲突和局部例外的结构化对比。
2. 把项目范围的候选提醒偏好和候选指纹的 \`rejected\` 负向权重接入推荐排序；权重只改变
   提醒频率和触发阈值，不改变知识真值、确认权威或作用域。
3. 子项目保留同稳定键局部覆盖时，在 Agent 输出中解释“继承自 A”或“由 B 覆盖 A”。
4. 用领域嵌入或可解释规则扩充召回，但继续把相似度限制在只读候选阶段。

## Recommended Agent Integration Improvements

1. 为 Codex、Cursor、Kiro 增加等价生命周期适配，逐项报告 Hook enforced 或 Prompt fallback。
2. 给高阶当前项目搜索增加来源解释摘要，直接区分 local、inherited 和 overridden。
3. 对多概念问题返回逐查询命中/未命中和负面证据警告。
4. 为既有 Decision 增加追加验证入口，创建不可变 ValidationResult 并关联原轨迹，避免调用方
   重建或覆盖原决策。
5. 建立 30 个以上配对任务的协作成本、错误复发与安全回归统计。

## Method and Sources

测试题型参考
[LoCoMo](https://github.com/snap-research/locomo) 的长对话与跨会话问答、
[LongMemEval](https://github.com/xiaowu0162/longmemeval) 的知识更新/时间/拒答能力，以及
[SWE-bench](https://www.swebench.com/) 的仓库证据任务结构。
[LMSYS-Chat-1M](https://huggingface.co/datasets/lmsys/lmsys-chat-1m)
只用于了解公开对话题型分布；本轮没有下载或复制真实会话。
Claude Code 的 MCP 加载行为依据
[Claude Code MCP 官方文档](https://code.claude.com/docs/en/mcp)；生命周期入口和 Stop Gate
依据 [Claude Code Hooks 官方文档](https://code.claude.com/docs/en/hooks)。

结构化、脱敏的逐项结果见
\`acceptance/alignment/results/latest.json\`；轻量 Hook 结果见
\`acceptance/alignment/results/hook-smoke-latest.json\`。复现命令见
\`acceptance/alignment/README.md\`。

## Limitations

${result.limitations.map((item) => `- ${item}`).join('\n')}
`;
}

function readOptionalJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function summarize(cases, infrastructureError) {
  const counts = {};
  for (const item of cases) counts[item.status] = (counts[item.status] ?? 0) + 1;
  let overall = 'PASS';
  if (infrastructureError || (counts.ERROR ?? 0) > 0) {
    overall = 'FAIL';
  } else if ((counts.FAIL ?? 0) > 0 || (counts.SKIP ?? 0) > 0) {
    overall = 'PARTIAL';
  }
  return {
    overall,
    counts,
    keyFinding: cases.find(({ id }) => id === 'CONVERGE-03')?.status === 'PASS'
      ? 'Child-first parent inheritance and human-confirmed atomic common promotion both work.'
      : 'See per-case results.'
  };
}

function printSummary(result) {
  const report = relative(REPOSITORY_ROOT, REPORT_PATH);
  const data = relative(REPOSITORY_ROOT, RESULT_PATH);
  process.stdout.write(`\n完成：${result.summary.overall}\n`);
  process.stdout.write(`报告：${report}\n`);
  process.stdout.write(`结构化结果：${data}\n`);
}

async function runProcess(command, args, {
  cwd,
  env = process.env,
  timeoutMs = 120_000,
  maxOutputBytes = 4 * 1024 * 1024
} = {}) {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > maxOutputBytes
        ? next.slice(next.length - maxOutputBytes)
        : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      rejectPromise(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      const durationMs = Date.now() - startedAt;
      if (code === 0 && !timedOut) {
        resolvePromise({ stdout, stderr, durationMs });
        return;
      }
      const rawDetail = stderr || stdout || `signal=${signal ?? 'none'}`;
      const detail = sanitizeText(rawDetail.slice(-1800), 1800);
      rejectPromise(new Error(
        timedOut
          ? `${command} timed out after ${timeoutMs}ms`
          : `${command} exited with code ${code}: ${detail}`
      ));
    });
  });
}

async function tryRunProcess(command, args, options) {
  const startedAt = Date.now();
  try {
    const result = await runProcess(command, args, options);
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - startedAt,
      error: sanitizeError(error)
    };
  }
}

function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) rejectPromise(error);
        else if (!port) rejectPromise(new Error('Could not allocate a loopback port'));
        else resolvePromise(port);
      });
    });
  });
}

function findItem(result, marker) {
  return [...(result.entities ?? []), ...(result.facts ?? [])]
    .find((item) => itemText(item).includes(marker)) ?? null;
}

function itemText(item) {
  return [
    item.name,
    item.summary,
    item.fact,
    item.key,
    item.source_entity,
    item.target_entity
  ].filter(Boolean).join(' ');
}

function allText(result) {
  return [...(result.entities ?? []), ...(result.facts ?? [])]
    .map(itemText)
    .join('\n');
}

function markers(text, values) {
  return values.filter((value) => String(text ?? '').includes(value));
}

function countMarkdownFiles(root) {
  let count = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) count += countMarkdownFiles(path);
    else if (entry.endsWith('.md')) count += 1;
  }
  return count;
}

function validateArguments(args) {
  const unknown = args.filter((value) => !SUPPORTED_ARGUMENTS.has(value));
  if (unknown.length) {
    throw new TypeError(`Unknown alignment runner argument: ${unknown.join(', ')}`);
  }
}

function positiveNumber(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError('FULI_ALIGNMENT_CLAUDE_BUDGET_USD must be positive');
  }
  return parsed;
}

function claudeEffort(value) {
  const resolved = nonEmpty(value) ?? 'medium';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(resolved)) {
    throw new TypeError(
      'FULI_ALIGNMENT_CLAUDE_EFFORT must be low, medium, high, xhigh, or max'
    );
  }
  return resolved;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sanitizeError(error) {
  return sanitizeText(error instanceof Error ? error.message : String(error), 1200);
}

function sanitizeText(value, limit = 1200) {
  let result = String(value ?? '');
  if (state.temporaryRoot) result = result.replaceAll(state.temporaryRoot, '<temporary>');
  result = result.replaceAll(REPOSITORY_ROOT, '<repository>');
  result = result
    .replace(/\/Users\/[^/\s]+/g, '<user-home>')
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, '<loopback-provider>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>');
  return result.length > limit ? `${result.slice(0, limit)}…` : result;
}

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function stage(message) {
  process.stdout.write(`\n${message}…\n`);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
