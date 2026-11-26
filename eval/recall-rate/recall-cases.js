// The graded cases. Every case names what must come back and what must not,
// so a number here means "the right thing arrived", not "something arrived".
//
// `expect` is the gold answer: the task cannot be done well without it.
// `forbid` is a near miss or an out-of-scope item: delivering it is the
// "irrelevant recall" complaint, and it costs tokens either way.

import { PROJECTS } from './knowledge-world.js';

const LEDGER = PROJECTS.ledger;
const SITE = PROJECTS.site;

// --- A. preferences the entry delivers on its own -----------------------
// Each task states the scope FULI resolves for it. A preference with no
// qualifier applies everywhere; a qualified one applies only where it says.
export const PREFERENCE_CASES = [
  { id: 'pa-implementation', scope: { workKind: 'implementation' },
    about: '普通开发任务',
    expect: ['pref-reply-language', 'pref-no-emoji', 'pref-commit-style'],
    forbid: ['pref-region-locale', 'pref-changelog-check'] },
  { id: 'pa-test-validation', scope: { workKind: 'test_validation' },
    about: '验收任务，地区规则适用',
    expect: ['pref-reply-language', 'pref-region-locale'],
    forbid: ['pref-changelog-check'] },
  { id: 'pa-release-workflow', scope: { workKind: 'implementation', workflow: 'release' },
    about: '发布流程，changelog 检查适用',
    expect: ['pref-reply-language', 'pref-changelog-check'],
    forbid: ['pref-region-locale'] },
  { id: 'pa-architecture', scope: { workKind: 'architecture' },
    about: '纯架构分析，两条范围限定的都不该来',
    expect: ['pref-reply-language', 'pref-no-emoji'],
    forbid: ['pref-region-locale', 'pref-changelog-check'] },
  { id: 'pa-code-review', scope: { workKind: 'code_review' },
    about: '评审任务',
    expect: ['pref-reply-language', 'pref-commit-style'],
    forbid: ['pref-region-locale', 'pref-changelog-check'] },
  // rec#111 11-22: a rule scoped in prose only reached a review task and was
  // applied as a review criterion. Nothing structured says it should not.
  { id: 'pa-prose-scope-leak', scope: { workKind: 'code_review' },
    about: '评审任务，只写在正文里的「仅适用于 PRD 评审」范围',
    expect: ['pref-reply-language'],
    forbid: ['pref-prd-only'],
    knownGap: 'prose_scope_not_structured' }
];

// --- B. what the task entry recalls on its own --------------------------
export const ENTRY_CASES = [
  { id: 'eb-release', prompt: '潮池账本这版改完了，按我们的流程发布一下。',
    expect: ['lg-release-runbook'], forbid: ['lg-settlement-day-old', 'nm-ledger-palette'] },
  { id: 'eb-staging-where', prompt: '预发布环境的地址是什么？我要去看一下对账页面。',
    expect: ['lg-staging-url'], forbid: ['st-deploy-url', 'nm-ledger-palette'] },
  { id: 'eb-verify', prompt: '改完之后把测试都跑通再给我。',
    expect: ['lg-verify-command'], forbid: ['nm-ledger-sprint'] },
  { id: 'eb-settlement', prompt: '结算日这块的逻辑我忘了，之前是怎么定的？',
    expect: ['lg-settlement-day'], forbid: ['lg-settlement-day-old'] },
  { id: 'eb-error-code', prompt: '给对账失败加一个错误码，按我们的约定来。',
    expect: ['lg-error-codes'], forbid: ['nm-ledger-logging'] },
  { id: 'eb-port', prompt: '本地连不上预发布，端口是多少？',
    expect: ['lg-staging-port'], forbid: ['lg-staging-port-old'] },
  { id: 'eb-owner', prompt: '这个接口改动要谁拍板？',
    expect: ['lg-review-owner'], forbid: ['nm-ledger-sprint'] },
  { id: 'eb-principle', prompt: '按潮池账本的产品原则看，这个新功能该不该做？',
    expect: ['lg-product-principle'], forbid: ['nm-ledger-palette', 'nm-ledger-icon'] },
  { id: 'eb-en-release', prompt: 'Release the ledger build using the runbook we agreed on.',
    expect: ['lg-release-runbook'], forbid: ['st-deploy-url'] },
  { id: 'eb-en-where', prompt: 'Where is the staging address for the ledger?',
    expect: ['lg-staging-url'], forbid: ['st-deploy-url'] },
  { id: 'eb-mixed', prompt: '把 retry 重试策略确认一下，对账接口失败之后怎么办。',
    expect: ['lg-retry-policy'], forbid: ['nm-ledger-logging'] },
  // Nothing stored answers this; the right outcome is an honest miss.
  { id: 'eb-nothing-stored', prompt: '把这个数组按数字从小到大排序。',
    expect: [], forbid: ['pref-bilingual-ui', 'nm-ledger-palette', 'lg-release-runbook'] },
  { id: 'eb-unrelated-receipt', prompt: '收到，另一个会话说他那边跑完了。',
    expect: [], forbid: ['lg-release-runbook', 'pref-bilingual-ui'] },
  // Hard cases (`category`, reported apart): asked in other words than the
  // answer was written in, or about an item written without retrieval terms.
  { id: 'eb-golive', category: 'project_name_only', prompt: '潮池账本今天上线，按老规矩走一遍。',
    expect: ['lg-release-runbook'], forbid: ['st-release-runbook'] },
  { id: 'eb-standby', category: 'synonym', prompt: '线上出问题了，值守的人在哪个群？',
    expect: ['lg-oncall-channel'], forbid: ['st-oncall-channel'] },
  { id: 'eb-backup', category: 'no_retrieval_terms', prompt: '潮池账本的备份留多久？',
    expect: ['lg-backup'], forbid: [] }
];

// --- C. focused searches an Agent makes on its own ----------------------
// A `call` is one tool invocation: the one to four focused queries the tool's
// own guidance asks for. `language` is the query language, not the knowledge's.
export const SEARCH_CALLS = [
  { id: 'sc-principle-zh', language: 'zh',
    about: 'rec#111 11-22 的真实情形：想知道产品原则',
    queries: ['潮池账本 产品原则', '产品理念 期望', '新功能 取舍', '默认值 做减法'],
    expect: ['lg-product-principle'], forbid: ['pref-bilingual-ui', 'nm-ledger-palette', 'nm-ledger-icon'] },
  { id: 'sc-release-zh', language: 'zh',
    queries: ['发布 流程 runbook', '打 tag 发布命令'],
    expect: ['lg-release-runbook'], forbid: ['st-deploy-url', 'nm-ledger-sprint'] },
  { id: 'sc-address-zh', language: 'zh',
    queries: ['预发布 地址', '预发布 端口'],
    expect: ['lg-staging-url', 'lg-staging-port'], forbid: ['lg-staging-port-old', 'st-deploy-url'] },
  { id: 'sc-settlement-zh', language: 'zh',
    queries: ['结算日 时区', '结算 本地时间'],
    expect: ['lg-settlement-day'], forbid: ['lg-settlement-day-old'] },
  { id: 'sc-owner-zh', language: 'zh',
    queries: ['评审 负责人 拍板'],
    expect: ['lg-review-owner'], forbid: ['nm-ledger-sprint', 'pref-bilingual-ui'] },
  { id: 'sc-retention-zh', language: 'zh',
    queries: ['数据留存 多久', '历史 快照'],
    expect: ['lg-data-retention'], forbid: ['nm-ledger-logging'] },
  { id: 'sc-error-zh', language: 'zh',
    queries: ['错误码 约定'],
    expect: ['lg-error-codes'], forbid: ['nm-ledger-logging', 'lg-rate-limit'] },
  { id: 'sc-release-en', language: 'en',
    queries: ['release runbook', 'publish command tag'],
    expect: ['lg-release-runbook'], forbid: ['st-build-command'] },
  { id: 'sc-address-en', language: 'en',
    queries: ['staging address', 'staging port'],
    expect: ['lg-staging-url', 'lg-staging-port'], forbid: ['lg-staging-port-old', 'st-deploy-url'] },
  { id: 'sc-verify-en', language: 'en',
    queries: ['verify command', 'how to run the checks'],
    expect: ['lg-verify-command'], forbid: ['st-build-command'] },
  { id: 'sc-oncall-en', language: 'en',
    queries: ['oncall channel'],
    expect: ['lg-oncall-channel'], forbid: ['nm-ledger-sprint'] },
  { id: 'sc-import-en', language: 'en',
    queries: ['import file format csv'],
    expect: ['lg-import-format'], forbid: ['nm-site-analytics'] },
  { id: 'sc-retry-mixed', language: 'mixed',
    queries: ['retry 重试策略', '对账接口 failure 退避'],
    expect: ['lg-retry-policy'], forbid: ['nm-ledger-logging'] },
  { id: 'sc-rate-mixed', language: 'mixed',
    queries: ['rate limit 限流 租户'],
    expect: ['lg-rate-limit'], forbid: ['lg-error-codes'] },
  { id: 'sc-commit-mixed', language: 'mixed',
    queries: ['commit message 提交信息 格式'],
    expect: ['pref-commit-style'], forbid: ['pref-bilingual-ui'] },
  { id: 'sc-principle-mixed', language: 'mixed',
    queries: ['product principle 产品原则', 'tidepool ledger 不做什么'],
    expect: ['lg-product-principle'], forbid: ['pref-bilingual-ui', 'nm-ledger-glossary'] },
  // The project's own name is in almost every query an Agent or the entry
  // writes, and almost every item carries it. It must not be what matches.
  { id: 'sc-named-project-zh', language: 'zh',
    about: '查询里带项目名，这是入口生成的查询的常态',
    queries: ['潮池账本 发布流程', '潮池账本 打 tag 命令'],
    expect: ['lg-release-runbook'],
    forbid: ['lg-staging-url', 'lg-oncall-channel', 'lg-error-codes', 'lg-verify-command'] },
  { id: 'sc-named-project-mixed', language: 'mixed',
    queries: ['tidepool ledger 错误码 约定'],
    expect: ['lg-error-codes'],
    forbid: ['lg-oncall-channel', 'lg-staging-url', 'lg-rate-limit'] },
  // Full-width punctuation is what a Chinese keyboard produces.
  { id: 'sc-fullwidth-zh', language: 'zh',
    about: '全角标点的中文查询',
    queries: ['结算日，是按什么时区算的？'],
    expect: ['lg-settlement-day'], forbid: ['lg-settlement-day-old', 'nm-ledger-sprint'] },
  // A flagged item is still current; it must not win over the clean answer.
  { id: 'sc-flagged-zh', language: 'zh',
    queries: ['对账文件 导入 编码'],
    expect: ['lg-import-format'], forbid: ['nm-import-flagged'] },
  // A broad first query and the answer in a later one. Every fact in the
  // project literally contains the project's name, so the broad query is a
  // whole-phrase match on all of them and legitimately returns them all.
  // What must not happen is that they spend the page the answer needed.
  // The shape the entry itself writes: the project's name prefixed onto each
  // category query, plus the one query that actually names the thing asked.
  { id: 'sc-broad-first-zh', language: 'zh',
    about: '前几个查询都带项目名，答案在最后一个查询里',
    queries: ['潮池账本 约定', '潮池账本 接口', '潮池账本 说明', '对账接口 失败 退避 重试'],
    expect: ['lg-retry-policy'], forbid: [] },

  // --- hard cases, reported per `category` as well as in the totals -----
  // Other words than the answer's. Without vectors nothing but a retrieval
  // term can bridge them, and none of these answers has one that does.
  { id: 'sc-syn-golive', language: 'zh', category: 'synonym', queries: ['上线 步骤'],
    expect: ['lg-release-runbook'], forbid: [] },
  { id: 'sc-syn-standby', language: 'zh', category: 'synonym', queries: ['值守 群'],
    expect: ['lg-oncall-channel'], forbid: [] },
  { id: 'sc-syn-clearing', language: 'zh', category: 'synonym', queries: ['清算 哪天'],
    expect: ['lg-settlement-day'], forbid: [] },
  { id: 'sc-syn-en', language: 'en', category: 'synonym', queries: ['go live steps'],
    expect: ['lg-release-runbook'], forbid: [] },
  // The same, with the project's name: now the answer shares a word with the
  // query, but so does every other item in the project.
  { id: 'sc-name-golive', language: 'zh', category: 'project_name_only', queries: ['潮池账本 上线 步骤'],
    expect: ['lg-release-runbook'], forbid: [] },
  { id: 'sc-name-standby', language: 'zh', category: 'project_name_only', queries: ['潮池账本 值守 群'],
    expect: ['lg-oncall-channel'], forbid: [] },
  { id: 'sc-name-clearing', language: 'zh', category: 'project_name_only', queries: ['潮池账本 清算 哪天'],
    expect: ['lg-settlement-day'], forbid: [] },
  { id: 'sc-name-test', language: 'zh', category: 'project_name_only', queries: ['潮池账本 测试 怎么跑'],
    expect: ['lg-verify-command'], forbid: [] },
  // ...and one where another item carries a word of the query that tells it
  // apart (线上, in the oncall fact), so the answer is not the only match.
  { id: 'sc-name-online', language: 'zh', category: 'project_name_only', queries: ['潮池账本 线上 步骤'],
    expect: ['lg-release-runbook'], forbid: [] },
  // Two projects in scope, each with an item of the same name; the active
  // project's is the answer unless the query names the other one.
  { id: 'sc-same-release', language: 'zh', category: 'same_name', queries: ['发布流程'],
    scope: { project_ids: [LEDGER, SITE] },
    expect: ['lg-release-runbook'], forbid: ['st-release-runbook'] },
  { id: 'sc-same-error', language: 'zh', category: 'same_name', queries: ['错误码 约定'],
    scope: { project_ids: [LEDGER, SITE] },
    expect: ['lg-error-codes'], forbid: ['st-error-codes'] },
  { id: 'sc-same-oncall-site', language: 'zh', category: 'same_name', queries: ['值班频道'],
    scope: { project_ids: [LEDGER, SITE], active_project_id: SITE },
    expect: ['st-oncall-channel'], forbid: ['lg-oncall-channel'] },
  { id: 'sc-same-named-other', language: 'zh', category: 'same_name', queries: ['灯笼鱼官网 发布流程'],
    scope: { project_ids: [LEDGER, SITE] },
    expect: ['st-release-runbook'], forbid: ['lg-release-runbook'] },
  // Written without retrieval terms: found by the item's own words.
  { id: 'sc-noterms-backup', language: 'zh', category: 'no_retrieval_terms', queries: ['备份 保留 多久'],
    expect: ['lg-backup'], forbid: [] },
  { id: 'sc-noterms-flag', language: 'zh', category: 'no_retrieval_terms', queries: ['灰度 开关 比例'],
    expect: ['lg-feature-flag'], forbid: [] },
  { id: 'sc-noterms-site', language: 'en', category: 'no_retrieval_terms', queries: ['lanternfish oncall'],
    scope: { project_ids: [SITE], active_project_id: SITE },
    expect: ['st-oncall-channel'], forbid: [] }
];

export const CATEGORIES = ['synonym', 'project_name_only', 'same_name', 'no_retrieval_terms'];

export const SEARCH_SCOPE = {
  project_ids: [LEDGER],
  active_project_id: LEDGER,
  include_personal_global: true,
  include_pending: true,
  include_historical: false
};
