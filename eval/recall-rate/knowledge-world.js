// A fictional personal space with two projects, used by the recall-rate
// benchmark. Nothing here names a real person, project, host or path:
// addresses use example.test and 192.0.2.0/24 (RFC 5737).
//
// `items` are what a search may return. A relationship carries `fact` and its
// two endpoint names; an entity carries `summary`. A preference is any item
// with `profile_aspect`: entry recall drops those, on-demand search keeps them,
// which is exactly the difference the benchmark measures.

const LEDGER = 'tidepool-ledger';
const SITE = 'lanternfish-site';

const confirmedBy = (kind, at = '2026-03-01T00:00:00Z') => ({
  existence_reason: 'Fictional statement written for an offline benchmark.',
  quadrant_reason: 'Stated outright in the fixture scenario.',
  proposed_by: { kind: 'agent' },
  confirmed_by: { kind },
  confirmed_at: at
});
const proposed = () => ({
  existence_reason: 'Fictional statement written for an offline benchmark.',
  quadrant_reason: 'Stated outright in the fixture scenario.',
  proposed_by: { kind: 'agent' }
});

function fact({ id, project = LEDGER, relationship, source, target, text, status = 'confirmed',
  by = 'user', aspect = null, qualifiers = null, invalidAt = null, uses = 4, tasks = 2,
  terms = [], attention = false, scopeDistance = 0 }) {
  return {
    id,
    kind: 'relationship',
    name: relationship,
    source_entity: source,
    target_entity: target,
    fact: text,
    defined_project_id: project,
    scope: project ? 'project' : 'personal',
    scope_distance: scopeDistance,
    confirmation_status: status,
    confirmation_basis_json: status === 'pending' ? proposed() : confirmedBy(by),
    qualified_use_count: uses,
    distinct_task_count: tasks,
    negative_evidence_count: 0,
    requires_attention: attention,
    last_used_at: '2026-10-01T00:00:00Z',
    created_at: '2026-02-01T00:00:00Z',
    invalid_at: invalidAt,
    retrieval_terms: terms,
    ...(aspect ? { profile_aspect: aspect, preference_scope: project ? 'project' : 'global' } : {}),
    ...(qualifiers ? { preference_qualifiers: qualifiers } : {})
  };
}

function entity({ id, project = LEDGER, name, type = 'Knowledge', summary, status = 'confirmed',
  by = 'user', uses = 4, tasks = 2, terms = [], invalidAt = null, scopeDistance = 0 }) {
  return {
    id,
    kind: 'entity',
    name,
    type,
    summary,
    defined_project_id: project,
    scope: project ? 'project' : 'personal',
    scope_distance: scopeDistance,
    confirmation_status: status,
    confirmation_basis_json: status === 'pending' ? proposed() : confirmedBy(by),
    qualified_use_count: uses,
    distinct_task_count: tasks,
    negative_evidence_count: 0,
    requires_attention: false,
    last_used_at: '2026-10-01T00:00:00Z',
    created_at: '2026-02-01T00:00:00Z',
    invalid_at: invalidAt,
    retrieval_terms: terms
  };
}

export const PROJECTS = { ledger: LEDGER, site: SITE };

export const ITEMS = [
  // --- tidepool-ledger: addresses, commands, decisions, runbooks ---------
  fact({ id: 'lg-staging-url', relationship: 'STAGING_ADDRESS', source: '潮池账本', target: '预发布环境',
    text: '潮池账本的预发布环境地址是 https://staging.tidepool.example.test，内网入口 192.0.2.17。',
    terms: ['staging', '预发布', 'address', '地址'] }),
  fact({ id: 'lg-verify-command', relationship: 'VERIFY_COMMAND', source: '潮池账本', target: '验收命令',
    text: '潮池账本跑验收用 npm run verify:ledger，不要直接跑 npm test。',
    terms: ['verify', '验收', 'command', '命令'] }),
  fact({ id: 'lg-settlement-day', relationship: 'SETTLEMENT_RULE', source: '潮池账本', target: '结算日',
    text: '结算日按账户所在地的本地时间计算，每月 3 日 02:00 本地时间触发。',
    terms: ['settlement', '结算', 'timezone', '时区'] }),
  fact({ id: 'lg-settlement-day-old', relationship: 'SETTLEMENT_RULE', source: '潮池账本', target: '结算日',
    text: '结算日按 UTC 计算，每月 3 日 02:00 UTC 触发。',
    invalidAt: '2026-06-01T00:00:00Z', terms: ['settlement', '结算'] }),
  fact({ id: 'lg-release-runbook', relationship: 'RELEASE_RUNBOOK', source: '潮池账本', target: '发布流程',
    text: '发布潮池账本：先打 tag，再跑 npm run publish:ledger，最后在值班频道贴变更说明。',
    terms: ['release', '发布', 'runbook', '流程'] }),
  fact({ id: 'lg-error-codes', relationship: 'ERROR_CODE_CONVENTION', source: '潮池账本', target: '错误码',
    text: '错误码一律用 TPL-#### 四位数字，不要自己编字母前缀。',
    terms: ['error code', '错误码', 'convention', '约定'] }),
  fact({ id: 'lg-oncall-channel', relationship: 'ONCALL_CHANNEL', source: '潮池账本', target: '值班频道',
    text: '潮池账本的值班频道是 #tidepool-oncall，线上故障先在那里喊人。',
    terms: ['oncall', '值班', 'channel', '频道'] }),
  fact({ id: 'lg-staging-port-old', relationship: 'STAGING_PORT', source: '潮池账本', target: '预发布端口',
    text: '预发布环境监听 8080 端口。', invalidAt: '2026-05-01T00:00:00Z', terms: ['port', '端口'] }),
  fact({ id: 'lg-staging-port', relationship: 'STAGING_PORT', source: '潮池账本', target: '预发布端口',
    text: '预发布环境监听 8443 端口，只收 HTTPS。', terms: ['port', '端口'] }),
  fact({ id: 'lg-retry-policy', relationship: 'RETRY_POLICY', source: '潮池账本', target: '重试策略',
    text: '对账接口失败后退避重试三次，间隔 2 秒、8 秒、30 秒，再失败就落到人工队列。',
    status: 'pending', terms: ['retry', '重试'] }),
  fact({ id: 'lg-review-owner', relationship: 'REVIEW_OWNER', source: '潮池账本', target: '评审负责人',
    text: '账务相关改动由结算组拍板，接口改动由平台组拍板。',
    terms: ['owner', '负责人', 'review', '评审'] }),
  entity({ id: 'lg-product-principle', name: '潮池账本的产品原则',
    summary: '潮池账本只做记账和对账，不做风控；任何新功能先问「不做行不行」，默认值要能直接用。',
    terms: ['产品原则', 'product principle', '理念', '期望'] }),
  entity({ id: 'lg-data-retention', name: '潮池账本的数据留存',
    summary: '流水永久保留，快照保留 18 个月；历史版本和当前答案分开存。',
    terms: ['retention', '留存', '历史'] }),
  entity({ id: 'lg-import-format', name: '潮池账本的导入格式',
    summary: '对账文件只收 UTF-8 的 CSV，列顺序固定，表头必须存在。', terms: ['import', '导入', 'csv'] }),
  entity({ id: 'lg-rate-limit', name: '潮池账本的限流',
    summary: '对外接口每个租户每分钟 600 次，超出返回 TPL-4290。', terms: ['rate limit', '限流'] }),

  // --- lanternfish-site --------------------------------------------------
  fact({ id: 'st-deploy-url', project: SITE, relationship: 'DEPLOY_ADDRESS', source: '灯笼鱼官网', target: '生产环境',
    text: '灯笼鱼官网发布到 https://www.lanternfish.example.test，构建产物放 dist/。',
    terms: ['deploy', '发布', '地址'] }),
  fact({ id: 'st-build-command', project: SITE, relationship: 'BUILD_COMMAND', source: '灯笼鱼官网', target: '构建命令',
    text: '灯笼鱼官网构建用 npm run build:site，构建前要先生成图标。', terms: ['build', '构建', '命令'] }),
  entity({ id: 'st-copy-tone', project: SITE, name: '灯笼鱼官网的文案语气',
    summary: '官网文案用生活里的词，不用行业黑话，一句话讲清一件事。', terms: ['copy', '文案', 'tone'] }),

  // --- written without retrieval terms -----------------------------------
  // What an Agent records in passing often carries none, so these are found
  // by their own words or not at all. Three share a name with a ledger item.
  fact({ id: 'st-release-runbook', project: SITE, relationship: 'RELEASE_RUNBOOK', source: '灯笼鱼官网',
    target: '发布流程', text: '发布灯笼鱼官网：合并到 main 后自动部署，不打 tag，部署完更新站点公告。' }),
  fact({ id: 'st-oncall-channel', project: SITE, relationship: 'ONCALL_CHANNEL', source: '灯笼鱼官网',
    target: '值班频道', text: '灯笼鱼官网的值班频道是 #lanternfish-oncall，页面打不开先在那里喊人。' }),
  fact({ id: 'st-error-codes', project: SITE, relationship: 'ERROR_CODE_CONVENTION', source: '灯笼鱼官网',
    target: '错误码', text: '官网前端的错误码用 LFS-### 三位数字，只出现在浏览器控制台里。' }),
  fact({ id: 'lg-backup', relationship: 'BACKUP_SCHEDULE', source: '潮池账本', target: '备份',
    text: '潮池账本每天 04:00 全量备份一次，备份保留 30 天。' }),
  entity({ id: 'lg-feature-flag', name: '潮池账本的灰度开关',
    summary: '新功能先在灰度开关后面开给 5% 的租户，观察一周再全量。' }),

  // --- near misses: plausible, share words, wrong answer -----------------
  entity({ id: 'nm-ledger-palette', name: '潮池账本的报表配色',
    summary: '报表配色用低饱和的蓝绿，不要用红色表示负数。', terms: ['配色', 'palette'] }),
  entity({ id: 'nm-ledger-icon', name: '潮池账本的图标规范',
    summary: '图标统一 24 像素线性风格，描边 1.5 像素。', terms: ['icon', '图标'] }),
  entity({ id: 'nm-site-analytics', project: SITE, name: '灯笼鱼官网的统计口径',
    summary: '官网访问量只统计去重后的独立访客，不统计爬虫。', terms: ['analytics', '统计'] }),
  entity({ id: 'nm-ledger-sprint', name: '潮池账本的迭代节奏',
    summary: '两周一个迭代，迭代第一天定范围，最后一天演示。', terms: ['sprint', '迭代'] }),
  entity({ id: 'nm-ledger-glossary', name: '潮池账本的名词表',
    summary: '「流水」指单条记账，「账期」指一个结算周期，不要混用。', terms: ['glossary', '名词'] }),
  entity({ id: 'nm-ledger-logging', name: '潮池账本的日志',
    summary: '日志只记结构化字段，不要把整个请求体打进去。', terms: ['logging', '日志'] }),
  // Still current, but flagged: it must not outrank the unflagged answer.
  fact({ id: 'nm-import-flagged', relationship: 'IMPORT_FORMAT', source: '潮池账本', target: '导入格式',
    text: '对账文件也可以收 GBK 编码的 CSV。', attention: true, terms: ['import', '导入', 'csv'] }),

  // --- preferences: global, project, scope-qualified ---------------------
  fact({ id: 'pref-reply-language', project: null, relationship: 'REPLY_LANGUAGE', source: '我', target: '回复语言',
    text: '所有回复用中文，只讲要点，不要客套。', aspect: 'personality',
    terms: ['reply language', '回复语言'] }),
  fact({ id: 'pref-no-emoji', project: null, relationship: 'REPLY_STYLE', source: '我', target: '回复风格',
    text: '回复里不要用表情符号。', aspect: 'personality', terms: ['emoji', '表情'] }),
  fact({ id: 'pref-commit-style', relationship: 'COMMIT_STYLE', source: '我', target: '提交信息',
    text: '潮池账本的提交信息用英文，格式 fix(scope): 一句话讲清行为变化。', aspect: 'judgment_preference',
    terms: ['commit message', '提交信息'] }),
  // The one that keeps winning queries it has nothing to do with (rec#111).
  fact({ id: 'pref-bilingual-ui', relationship: 'UI_COPY_RULE', source: '我', target: '界面文案',
    text: '界面文案中文和英文两套都要有，产品里不要只写一种语言。', aspect: 'taste',
    terms: ['bilingual', '双语', '界面文案'] }),
  // Scope-qualified: stated in prose AND structured, so the benchmark can tell
  // whether the structured qualifier is what actually filters.
  fact({ id: 'pref-region-locale', relationship: 'REGION_RULE', source: '我', target: '地区判断',
    text: '仅适用于验收类任务：地区只按 locale 判断，不要用 IP。', aspect: 'judgment_preference',
    qualifiers: { workKind: 'test_validation' }, terms: ['region', '地区', 'locale'] }),
  fact({ id: 'pref-changelog-check', relationship: 'RELEASE_CHECK', source: '我', target: '发布检查',
    text: 'Only for release workflows: re-read the changelog before tagging.', aspect: 'judgment_preference',
    qualifiers: { workflow: 'release' }, terms: ['changelog', '发布检查'] }),
  // Prose-only scope. No structured qualifier exists for it today; the
  // benchmark records it as a known mis-delivery, not as a passing case.
  fact({ id: 'pref-prd-only', relationship: 'PRD_RULE', source: '我', target: 'PRD 规则',
    text: '仅适用于 PRD 评审：每条需求都要写清不做什么。', aspect: 'judgment_preference',
    terms: ['prd', '评审'] })
];

export const KNOWLEDGE_ITEMS = ITEMS.filter(item => !item.profile_aspect);
export const PREFERENCE_ITEMS = ITEMS.filter(item => item.profile_aspect);
export const ITEMS_BY_ID = new Map(ITEMS.map(item => [item.id, item]));

// The same world with every hand-written retrieval term removed: how much of
// a result the terms carry, rather than the item's own words.
export const withoutRetrievalTerms = items => items.map(item => ({ ...item, retrieval_terms: [] }));
