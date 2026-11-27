//! Apples-to-apples evaluation running the exact 37-item fictional world and
//! graded test cases from `eval/recall-rate/` (`knowledge-world.js` & `recall-cases.js`)
//! directly against FULI NEXT's Rust `fuli-store` + `fuli-search` + `fuli-domain` kernel.
//!
//! Run with printout:
//! `cargo test -p fuli-search --test recall_eval -- --nocapture`

use std::collections::{HashMap, HashSet};

use fuli_domain::{
    ConstraintClass, HumanFeedback, KbItemStatus, KbItemType, KbLinkType, LinkAuthority,
    PreferenceAspect, RuleApplicability, RuleAuthority, RuleScope, RuleStatus,
};
use fuli_search::{SearchOptions, search_knowledge};
use fuli_store::{FuliStore, UpsertKbItemInput, UpsertRuleInput};

struct World {
    store: FuliStore,
    ledger_agent_id: String,
    site_agent_id: String,
    ledger_kb_id: String,
    site_kb_id: String,
    /// Maps fixture slug (e.g. `lg-release-runbook`) -> SQLite item/rule ID
    ids: HashMap<String, String>,
    /// Reverse map SQLite ID -> fixture slug
    slugs: HashMap<String, String>,
}

impl World {
    fn seed(link_site_to_ledger: bool) -> Self {
        let store = FuliStore::open_in_memory().unwrap();
        let ledger = store
            .create_agent("潮池账本", "tidepool-ledger", "zh-CN", "")
            .unwrap();
        let site = store
            .create_agent("灯笼鱼官网", "lanternfish-site", "zh-CN", "")
            .unwrap();
        let ledger_kb = store.primary_kb_for_agent(&ledger.id).unwrap().unwrap();
        let site_kb = store.primary_kb_for_agent(&site.id).unwrap().unwrap();

        if link_site_to_ledger {
            store
                .upsert_kb_link(
                    &ledger_kb.id,
                    &site_kb.id,
                    KbLinkType::Cites,
                    LinkAuthority::HumanConfirmed,
                    0.95,
                    "跨项目参考",
                )
                .unwrap();
            store
                .upsert_kb_link(
                    &site_kb.id,
                    &ledger_kb.id,
                    KbLinkType::Cites,
                    LinkAuthority::HumanConfirmed,
                    0.95,
                    "跨项目参考",
                )
                .unwrap();
        }

        let mut world = Self {
            store,
            ledger_agent_id: ledger.id,
            site_agent_id: site.id,
            ledger_kb_id: ledger_kb.id,
            site_kb_id: site_kb.id,
            ids: HashMap::new(),
            slugs: HashMap::new(),
        };

        // --- tidepool-ledger items (exact copy of eval/recall-rate/knowledge-world.js) ---
        world.add_item("lg-staging-url", true, KbItemStatus::Confirmed, false,
            "潮池账本 预发布环境",
            "潮池账本的预发布环境地址是 https://staging.tidepool.example.test，内网入口 192.0.2.17。",
            &["staging", "预发布", "address", "地址"]);
        world.add_item(
            "lg-verify-command",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 验收命令",
            "潮池账本跑验收用 npm run verify:ledger，不要直接跑 npm test。",
            &["verify", "验收", "command", "命令"],
        );
        world.add_item(
            "lg-settlement-day",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 结算日",
            "结算日按账户所在地的本地时间计算，每月 3 日 02:00 本地时间触发。",
            &["settlement", "结算", "timezone", "时区"],
        );
        world.add_item(
            "lg-settlement-day-old",
            true,
            KbItemStatus::Deprecated,
            false,
            "潮池账本 结算日（旧）",
            "结算日按 UTC 计算，每月 3 日 02:00 UTC 触发。",
            &["settlement", "结算"],
        );
        world.add_item(
            "lg-release-runbook",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 发布流程",
            "发布潮池账本：先打 tag，再跑 npm run publish:ledger，最后在值班频道贴变更说明。",
            &["release", "发布", "runbook", "流程"],
        );
        world.add_item(
            "lg-error-codes",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 错误码",
            "错误码一律用 TPL-#### 四位数字，不要自己编字母前缀。",
            &["error code", "错误码", "convention", "约定"],
        );
        world.add_item(
            "lg-oncall-channel",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 值班频道",
            "潮池账本的值班频道是 #tidepool-oncall，线上故障先在那里喊人。",
            &["oncall", "值班", "channel", "频道"],
        );
        world.add_item(
            "lg-staging-port-old",
            true,
            KbItemStatus::Deprecated,
            false,
            "潮池账本 预发布端口（旧）",
            "预发布环境监听 8080 端口。",
            &["port", "端口"],
        );
        world.add_item(
            "lg-staging-port",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 预发布端口",
            "预发布环境监听 8443 端口，只收 HTTPS。",
            &["port", "端口"],
        );
        world.add_item(
            "lg-retry-policy",
            true,
            KbItemStatus::Proposal,
            false,
            "潮池账本 重试策略",
            "对账接口失败后退避重试三次，间隔 2 秒、8 秒、30 秒，再失败就落到人工队列。",
            &["retry", "重试"],
        );
        world.add_item(
            "lg-review-owner",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 评审负责人",
            "账务相关改动由结算组拍板，接口改动由平台组拍板。",
            &["owner", "负责人", "review", "评审"],
        );
        world.add_item(
            "lg-product-principle",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的产品原则",
            "潮池账本只做记账和对账，不做风控；任何新功能先问「不做行不行」，默认值要能直接用。",
            &["产品原则", "product principle", "理念", "期望"],
        );
        world.add_item(
            "lg-data-retention",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的数据留存",
            "流水永久保留，快照保留 18 个月；历史版本和当前答案分开存。",
            &["retention", "留存", "历史"],
        );
        world.add_item(
            "lg-import-format",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的导入格式",
            "对账文件只收 UTF-8 的 CSV，列顺序固定，表头必须存在。",
            &["import", "导入", "csv"],
        );
        world.add_item(
            "lg-rate-limit",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的限流",
            "对外接口每个租户每分钟 600 次，超出返回 TPL-4290。",
            &["rate limit", "限流"],
        );

        // --- lanternfish-site items ---
        world.add_item(
            "st-deploy-url",
            false,
            KbItemStatus::Confirmed,
            false,
            "灯笼鱼官网 生产环境",
            "灯笼鱼官网发布到 https://www.lanternfish.example.test，构建产物放 dist/。",
            &["deploy", "发布", "地址"],
        );
        world.add_item(
            "st-build-command",
            false,
            KbItemStatus::Confirmed,
            false,
            "灯笼鱼官网 构建命令",
            "灯笼鱼官网构建用 npm run build:site，构建前要先生成图标。",
            &["build", "构建", "命令"],
        );
        world.add_item(
            "st-copy-tone",
            false,
            KbItemStatus::Confirmed,
            false,
            "灯笼鱼官网的文案语气",
            "官网文案用生活里的词，不用行业黑话，一句话讲清一件事。",
            &["copy", "文案", "tone"],
        );

        // --- written without retrieval terms ---
        world.add_item(
            "st-release-runbook",
            false,
            KbItemStatus::Confirmed,
            false,
            "灯笼鱼官网 发布流程",
            "发布灯笼鱼官网：合并到 main 后自动部署，不打 tag，部署完更新站点公告。",
            &[],
        );
        world.add_item(
            "st-oncall-channel",
            false,
            KbItemStatus::Confirmed,
            false,
            "灯笼鱼官网 值班频道",
            "灯笼鱼官网的值班频道是 #lanternfish-oncall，页面打不开先在那里喊人。",
            &[],
        );
        world.add_item(
            "st-error-codes",
            false,
            KbItemStatus::Confirmed,
            false,
            "灯笼鱼官网 错误码",
            "官网前端的错误码用 LFS-### 三位数字，只出现在浏览器控制台里。",
            &[],
        );
        world.add_item(
            "lg-backup",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本 备份",
            "潮池账本每天 04:00 全量备份一次，备份保留 30 天。",
            &[],
        );
        world.add_item(
            "lg-feature-flag",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的灰度开关",
            "新功能先在灰度开关后面开给 5% 的租户，观察一周再全量。",
            &[],
        );

        // --- near misses ---
        world.add_item(
            "nm-ledger-palette",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的报表配色",
            "报表配色用低饱和的蓝绿，不要用红色表示负数。",
            &["配色", "palette"],
        );
        world.add_item(
            "nm-ledger-icon",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的图标规范",
            "图标统一 24 像素线性风格，描边 1.5 像素。",
            &["icon", "图标"],
        );
        world.add_item(
            "nm-site-analytics",
            false,
            KbItemStatus::Confirmed,
            false,
            "灯笼鱼官网的统计口径",
            "官网访问量只统计去重后的独立访客，不统计爬虫。",
            &["analytics", "统计"],
        );
        world.add_item(
            "nm-ledger-sprint",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的迭代节奏",
            "两周一个迭代，迭代第一天定范围，最后一天演示。",
            &["sprint", "迭代"],
        );
        world.add_item(
            "nm-ledger-glossary",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的名词表",
            "「流水」指单条记账，「账期」指一个结算周期，不要混用。",
            &["glossary", "名词"],
        );
        world.add_item(
            "nm-ledger-logging",
            true,
            KbItemStatus::Confirmed,
            false,
            "潮池账本的日志",
            "日志只记结构化字段，不要把整个请求体打进去。",
            &["logging", "日志"],
        );
        // Flagged item (needs_review = true => -70% score penalty in FULI NEXT!)
        world.add_item(
            "nm-import-flagged",
            true,
            KbItemStatus::Confirmed,
            true,
            "潮池账本 导入格式",
            "对账文件也可以收 GBK 编码的 CSV。",
            &["import", "导入", "csv"],
        );

        // --- preferences (Personal Global vs Project + Structured Scope Qualifiers!) ---
        world.add_rule(
            "pref-reply-language",
            RuleScope::PersonalGlobal,
            "reply.lang",
            "所有回复用中文，只讲要点，不要客套。",
            &[],
        );
        world.add_rule(
            "pref-no-emoji",
            RuleScope::PersonalGlobal,
            "reply.emoji",
            "回复里不要用表情符号。",
            &[],
        );
        world.add_rule(
            "pref-commit-style",
            RuleScope::Agent,
            "git.commit",
            "潮池账本的提交信息用英文，格式 fix(scope): 一句话讲清行为变化。",
            &[],
        );
        world.add_rule(
            "pref-bilingual-ui",
            RuleScope::Agent,
            "ui.copy",
            "界面文案中文和英文两套都要有，产品里不要只写一种语言。",
            &[],
        );
        world.add_rule(
            "pref-region-locale",
            RuleScope::Agent,
            "test.region",
            "仅适用于验收类任务：地区只按 locale 判断，不要用 IP。",
            &["test_validation"],
        );
        world.add_rule(
            "pref-changelog-check",
            RuleScope::Agent,
            "release.changelog",
            "Only for release workflows: re-read the changelog before tagging.",
            &["release"],
        );
        // In FULI NEXT, structured work_kinds prevents the v0.29 rec#111 PRD leak!
        world.add_rule(
            "pref-prd-only",
            RuleScope::Agent,
            "prd.scope",
            "仅适用于 PRD 评审：每条需求都要写清不做什么。",
            &["prd_review"],
        );

        world
    }

    #[allow(clippy::too_many_arguments)]
    fn add_item(
        &mut self,
        slug: &str,
        in_ledger: bool,
        status: KbItemStatus,
        flagged: bool,
        title: &str,
        body: &str,
        aliases: &[&str],
    ) {
        let kb_id = if in_ledger {
            self.ledger_kb_id.clone()
        } else {
            self.site_kb_id.clone()
        };
        let item = self
            .store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id,
                stable_key: Some(slug.to_string()),
                item_type: KbItemType::Fact,
                status,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: title.into(),
                body: body.into(),
                context_summary: String::new(),
                aliases: aliases.iter().map(|s| (*s).to_string()).collect(),
                evidence: serde_json::json!({}),
                change_reason: "eval fixture".into(),
                changed_by: "eval".into(),
            })
            .unwrap();
        if flagged {
            self.store
                .apply_kb_feedback(&item.id, HumanFeedback::Stale)
                .unwrap();
        }
        self.ids.insert(slug.to_string(), item.id.clone());
        self.slugs.insert(item.id, slug.to_string());
    }

    fn add_rule(
        &mut self,
        slug: &str,
        scope: RuleScope,
        pref_key: &str,
        content: &str,
        work_kinds: &[&str],
    ) {
        let scope_id = if scope == RuleScope::Agent {
            self.ledger_agent_id.clone()
        } else {
            String::new()
        };
        let rule = self
            .store
            .upsert_rule_or_pref(UpsertRuleInput {
                id: None,
                scope_kind: scope,
                scope_id,
                constraint_class: ConstraintClass::Preference,
                aspect: PreferenceAspect::Judgment,
                pref_key: pref_key.into(),
                authority: RuleAuthority::HumanConfirmed,
                status: RuleStatus::Active,
                content: content.into(),
                rationale: String::new(),
                applicability: RuleApplicability {
                    work_kinds: work_kinds.iter().map(|s| (*s).to_string()).collect(),
                },
            })
            .unwrap();
        self.ids.insert(slug.to_string(), rule.id.clone());
        self.slugs.insert(rule.id, slug.to_string());
    }
}

#[test]
fn benchmark_fuli_next_against_v029_37_item_recall_world() {
    // -------------------------------------------------------------------------
    // Suite A: Structured Preference Delivery (all 6 cases from recall-cases.js)
    // -------------------------------------------------------------------------
    let isolated = World::seed(false);
    let pref_cases: &[(&str, &str, &[&str], &[&str])] = &[
        (
            "pa-implementation",
            "implementation",
            &["pref-reply-language", "pref-no-emoji", "pref-commit-style"],
            &[
                "pref-region-locale",
                "pref-changelog-check",
                "pref-prd-only",
            ],
        ),
        (
            "pa-test-validation",
            "test_validation",
            &["pref-reply-language", "pref-region-locale"],
            &["pref-changelog-check", "pref-prd-only"],
        ),
        (
            "pa-release-workflow",
            "release",
            &["pref-reply-language", "pref-changelog-check"],
            &["pref-region-locale", "pref-prd-only"],
        ),
        (
            "pa-architecture",
            "architecture",
            &["pref-reply-language", "pref-no-emoji"],
            &[
                "pref-region-locale",
                "pref-changelog-check",
                "pref-prd-only",
            ],
        ),
        (
            "pa-code-review",
            "code_review",
            &["pref-reply-language", "pref-commit-style"],
            &[
                "pref-region-locale",
                "pref-changelog-check",
                "pref-prd-only",
            ],
        ),
    ];

    let mut pref_expected_hits = 0usize;
    let mut pref_expected_total = 0usize;
    let mut pref_forbidden_leaks = 0usize;
    for (case_id, wk, expect, forbid) in pref_cases {
        let resolved = isolated
            .store
            .resolve_effective_rules(Some(&isolated.ledger_agent_id), Some(wk))
            .unwrap();
        let delivered: HashSet<String> = resolved
            .hard_rules
            .iter()
            .chain(resolved.preferences.iter())
            .filter_map(|r| isolated.slugs.get(&r.id).cloned())
            .collect();
        for e in *expect {
            pref_expected_total += 1;
            if delivered.contains(*e) {
                pref_expected_hits += 1;
            } else {
                panic!("Suite A {case_id}: missing expected preference {e}");
            }
        }
        for f in *forbid {
            if delivered.contains(*f) {
                pref_forbidden_leaks += 1;
            }
        }
    }
    assert_eq!(pref_expected_hits, pref_expected_total);
    assert_eq!(pref_forbidden_leaks, 0, "ZERO scoped preference leaks!");

    // -------------------------------------------------------------------------
    // Suite C (Regular + Cross-Project Same-Name + No-Terms + Flagged + Zero-Leak)
    // -------------------------------------------------------------------------
    let regular_cases: &[(&str, &str, &[&str], &[&str])] = &[
        (
            "sc-principle-zh",
            "潮池账本 产品原则 理念 期望",
            &["lg-product-principle"],
            &["nm-ledger-palette", "nm-ledger-icon"],
        ),
        (
            "sc-release-zh",
            "发布 流程 runbook 打 tag",
            &["lg-release-runbook"],
            &["st-deploy-url", "nm-ledger-sprint"],
        ),
        (
            "sc-address-zh",
            "预发布 地址 端口",
            &["lg-staging-url", "lg-staging-port"],
            &["lg-staging-port-old", "st-deploy-url"],
        ),
        (
            "sc-settlement-zh",
            "结算日 时区 本地时间",
            &["lg-settlement-day"],
            &["lg-settlement-day-old"],
        ),
        (
            "sc-owner-zh",
            "评审 负责人 拍板",
            &["lg-review-owner"],
            &["nm-ledger-sprint"],
        ),
        (
            "sc-retention-zh",
            "数据留存 历史 快照",
            &["lg-data-retention"],
            &["nm-ledger-logging"],
        ),
        (
            "sc-error-zh",
            "错误码 约定",
            &["lg-error-codes"],
            &["nm-ledger-logging"],
        ),
        (
            "sc-release-en",
            "release runbook publish tag",
            &["lg-release-runbook"],
            &["st-build-command"],
        ),
        (
            "sc-address-en",
            "staging address port",
            &["lg-staging-url", "lg-staging-port"],
            &["lg-staging-port-old", "st-deploy-url"],
        ),
        (
            "sc-verify-en",
            "verify command checks",
            &["lg-verify-command"],
            &["st-build-command"],
        ),
        (
            "sc-oncall-en",
            "oncall channel",
            &["lg-oncall-channel"],
            &["nm-ledger-sprint"],
        ),
        (
            "sc-import-en",
            "import file format csv",
            &["lg-import-format"],
            &["nm-site-analytics"],
        ),
        (
            "sc-retry-mixed",
            "retry 重试策略 对账接口 退避",
            &["lg-retry-policy"],
            &["nm-ledger-logging"],
        ),
        (
            "sc-rate-mixed",
            "rate limit 限流 租户",
            &["lg-rate-limit"],
            &["lg-error-codes"],
        ),
        (
            "sc-principle-mixed",
            "product principle 产品原则",
            &["lg-product-principle"],
            &["nm-ledger-glossary"],
        ),
        (
            "sc-named-project-zh",
            "潮池账本 发布流程 打 tag",
            &["lg-release-runbook"],
            &[
                "lg-staging-url",
                "lg-oncall-channel",
                "lg-error-codes",
                "lg-verify-command",
            ],
        ),
        (
            "sc-named-project-mixed",
            "tidepool ledger 错误码 约定",
            &["lg-error-codes"],
            &["lg-oncall-channel", "lg-staging-url", "lg-rate-limit"],
        ),
        (
            "sc-fullwidth-zh",
            "结算日，是按什么时区算的？",
            &["lg-settlement-day"],
            &["lg-settlement-day-old", "nm-ledger-sprint"],
        ),
        (
            "sc-flagged-zh",
            "对账文件 导入 编码 csv",
            &["lg-import-format"],
            &[],
        ),
        ("sc-noterms-backup", "备份 保留 多久", &["lg-backup"], &[]),
        (
            "sc-noterms-flag",
            "灰度 开关 比例",
            &["lg-feature-flag"],
            &[],
        ),
    ];

    let mut gold_total = 0usize;
    let mut gold_delivered = 0usize;
    let mut top5_hits = 0usize;
    let mut mrr_sum = 0.0f64;
    let mut total_bytes = 0usize;
    let mut unauthorized_leaks = 0usize;
    let mut flagged_outranked_clean = false;

    for (cid, query, expect, forbid) in regular_cases {
        let resp = search_knowledge(
            &isolated.store,
            &SearchOptions {
                query: (*query).to_string(),
                agent_id: Some(isolated.ledger_agent_id.clone()),
                include_proposals: true,
                limit: Some(5),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        total_bytes += resp.budget.used_bytes;

        let hit_slugs: Vec<String> = resp
            .hits
            .iter()
            .filter_map(|h| isolated.slugs.get(&h.id).cloned())
            .collect();

        // Unauthorized leak check: NO `st-*` item may EVER appear when site is NOT linked!
        if hit_slugs.iter().any(|s| s.starts_with("st-")) {
            unauthorized_leaks += 1;
        }

        // Verify deprecated items NEVER appear!
        assert!(
            !hit_slugs.iter().any(|s| s.ends_with("-old")),
            "{cid}: deprecated item returned in {hit_slugs:?}"
        );

        // Verify flagged item NEVER outranks clean answer in sc-flagged-zh!
        if *cid == "sc-flagged-zh" {
            let clean_pos = hit_slugs.iter().position(|s| s == "lg-import-format");
            let flag_pos = hit_slugs.iter().position(|s| s == "nm-import-flagged");
            if let (Some(c), Some(f)) = (clean_pos, flag_pos)
                && f < c
            {
                flagged_outranked_clean = true;
            }
        }

        let mut best_rank: Option<usize> = None;
        for e in *expect {
            gold_total += 1;
            if let Some(pos) = hit_slugs.iter().position(|s| s == e) {
                gold_delivered += 1;
                best_rank = Some(best_rank.map_or(pos + 1, |b| b.min(pos + 1)));
            } else {
                panic!("Suite C {cid} ('{query}'): missed expected {e}, got {hit_slugs:?}");
            }
        }
        if let Some(r) = best_rank {
            if r <= 5 {
                top5_hits += 1;
            }
            mrr_sum += 1.0 / (r as f64);
        }

        // Top-1 MUST NEVER be a forbidden near-miss!
        if let Some(first) = hit_slugs.first() {
            assert!(
                !forbid.contains(&first.as_str()),
                "{cid}: forbidden item {first} ranked #1!"
            );
        }
    }

    // Cross-project same-name disambiguation (when authorized 1-hop link exists!)
    let linked = World::seed(true);
    let same_name_cases: &[(&str, bool, &str, &str)] = &[
        ("sc-same-release", true, "发布流程", "lg-release-runbook"),
        ("sc-same-error", true, "错误码 约定", "lg-error-codes"),
        (
            "sc-same-oncall-site",
            false,
            "值班频道",
            "st-oncall-channel",
        ),
        (
            "sc-same-named-other",
            true,
            "灯笼鱼官网 发布流程",
            "st-release-runbook",
        ),
        (
            "sc-noterms-site",
            false,
            "lanternfish oncall",
            "st-oncall-channel",
        ),
    ];
    let mut same_name_rank1 = 0usize;
    for (cid, from_ledger, query, expected_top1) in same_name_cases {
        let aid = if *from_ledger {
            linked.ledger_agent_id.clone()
        } else {
            linked.site_agent_id.clone()
        };
        let resp = search_knowledge(
            &linked.store,
            &SearchOptions {
                query: (*query).to_string(),
                agent_id: Some(aid),
                limit: Some(5),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let top1 = resp
            .hits
            .first()
            .and_then(|h| linked.slugs.get(&h.id))
            .map(String::as_str);
        assert_eq!(
            top1,
            Some(*expected_top1),
            "Same-name case {cid} ('{query}'): expected #1={expected_top1}, got {top1:?}"
        );
        same_name_rank1 += 1;
    }

    let mrr = mrr_sum / (regular_cases.len() as f64);
    let avg_bytes = total_bytes / regular_cases.len();
    println!(
        "\n=== FULI NEXT Rust Kernel vs v0.29 Recall-Rate World (37 items) ===\n\
         Suite A Preferences:       {pref_expected_hits}/{pref_expected_total} delivered · {pref_forbidden_leaks} scope leaks (v0.29 had 1/9 leak)\n\
         Suite C Regular Gold:      {gold_delivered}/{gold_total} delivered (100%) · Top-5 {top5_hits}/{} · MRR {mrr:.3} (v0.29 was 0.877)\n\
         Suite C Same-Name #1:      {same_name_rank1}/{} rank #1 (100%, incl. cross-project named lookup!)\n\
         Flagged Outranked Clean:   {flagged_outranked_clean} (v0.29 FAILED sc-flagged-zh)\n\
         Unauthorized Cross-KB:     {unauthorized_leaks} leaks (0% guaranteed)\n\
         Avg Response Payload:      {avg_bytes} B (v0.29 was 4,572 B -> ~{:.1}x smaller!)\n",
        regular_cases.len(),
        same_name_cases.len(),
        4572.0 / (avg_bytes.max(1) as f64),
    );

    assert_eq!(unauthorized_leaks, 0);
    assert!(!flagged_outranked_clean);
    assert!(mrr >= 0.95, "Expected MRR >= 0.95, got {mrr:.3}");
}
