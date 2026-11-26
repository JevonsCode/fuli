pub mod error;
pub mod portable;
pub mod repo_detect;
pub mod schema;
pub mod store;
pub mod tokenizer;

pub use error::{StoreError, StoreResult};
pub use portable::{ImportSummary, PORTABLE_FORMAT_VERSION, PortableExportBundle};
pub use repo_detect::{DetectedRepo, detect_repo_at};
pub use store::{
    CheckpointInput, EmbeddingRow, FuliStore, PendingItemsSnapshot, UpsertKbItemInput,
    UpsertRuleInput,
};
pub use tokenizer::{build_fts5_match_query, is_cjk, tokenize_for_index, tokenize_query_terms};

#[cfg(test)]
mod tests {
    use super::*;
    use fuli_domain::{
        AgentResolution, BindingKind, BindingRole, ConstraintClass, DecisionRecord, HumanFeedback,
        KbItemStatus, KbItemType, KbLinkType, LinkAuthority, PreferenceAspect, ReusedRef,
        RuleApplicability, RuleAuthority, RuleScope, RuleStatus, WorkstreamStatus,
    };

    #[test]
    fn recursive_two_hop_kb_authorization_blocks_unconfirmed_and_third_hop_and_cycles() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent = store
            .create_agent("潮池账本", "个人财务应用", "zh-CN", "")
            .unwrap();
        let primary_kb = store.primary_kb_for_agent(&agent.id).unwrap().unwrap();

        let kb_hop1 = store.create_kb("公司规范库", "", "zh-CN", false).unwrap();
        let kb_hop2 = store.create_kb("安全底线库", "", "zh-CN", false).unwrap();
        let kb_hop3 = store.create_kb("三跳外库", "", "zh-CN", false).unwrap();
        let kb_unconfirmed = store.create_kb("未确认建议库", "", "zh-CN", false).unwrap();

        // Confirmed 1-hop & 2-hop + cycle back to primary + 3-hop (should be excluded)
        store
            .upsert_kb_link(
                &primary_kb.id,
                &kb_hop1.id,
                KbLinkType::Cites,
                LinkAuthority::HumanConfirmed,
                0.9,
                "引用规范",
            )
            .unwrap();
        store
            .upsert_kb_link(
                &kb_hop1.id,
                &kb_hop2.id,
                KbLinkType::Inherits,
                LinkAuthority::HumanConfirmed,
                0.8,
                "继承安全规范",
            )
            .unwrap();
        // Cycle back to primary must not infinite-loop!
        store
            .upsert_kb_link(
                &kb_hop2.id,
                &primary_kb.id,
                KbLinkType::Cites,
                LinkAuthority::HumanConfirmed,
                1.0,
                "cycle",
            )
            .unwrap();
        // 3rd hop must NOT be returned
        store
            .upsert_kb_link(
                &kb_hop2.id,
                &kb_hop3.id,
                KbLinkType::Cites,
                LinkAuthority::HumanConfirmed,
                1.0,
                "3rd hop",
            )
            .unwrap();
        // Suggested (unconfirmed) link must NOT be returned
        store
            .upsert_kb_link(
                &primary_kb.id,
                &kb_unconfirmed.id,
                KbLinkType::Cites,
                LinkAuthority::Suggested,
                1.0,
                "ai suggested",
            )
            .unwrap();

        let auth = store.authorized_kbs_for_agent(&agent.id).unwrap();
        let ids: Vec<(&str, u8)> = auth.iter().map(|a| (a.kb_id.as_str(), a.hop)).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&(primary_kb.id.as_str(), 0)));
        assert!(ids.contains(&(kb_hop1.id.as_str(), 1)));
        assert!(ids.contains(&(kb_hop2.id.as_str(), 2)));
        assert!(!ids.iter().any(|(id, _)| *id == kb_hop3.id));
        assert!(!ids.iter().any(|(id, _)| *id == kb_unconfirmed.id));
    }

    #[test]
    fn kb_item_updates_preserve_full_version_history_and_feedback_loop() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent = store.create_agent("FULI", "", "zh-CN", "").unwrap();
        let kb = store.primary_kb_for_agent(&agent.id).unwrap().unwrap();

        let v1 = store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb.id.clone(),
                stable_key: Some("release.process".into()),
                item_type: KbItemType::Runbook,
                status: KbItemStatus::Proposal,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: "发版流程".into(),
                body: "先跑测试再打 tag".into(),
                context_summary: "适用于 next 分支".into(),
                aliases: vec!["release runbook".into(), "上线".into()],
                evidence: serde_json::json!({"commit": "abc"}),
                change_reason: "initial".into(),
                changed_by: "agent".into(),
            })
            .unwrap();
        assert_eq!(v1.revision, 1);

        let v2 = store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb.id.clone(),
                stable_key: Some("release.process".into()),
                item_type: KbItemType::Runbook,
                status: KbItemStatus::Confirmed,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: "发版流程（双平台）".into(),
                body: "先跑 cargo test --workspace，再确认 Windows + macOS CI 全绿".into(),
                context_summary: "适用于 next 分支".into(),
                aliases: vec!["release runbook".into(), "上线".into()],
                evidence: serde_json::json!({"commit": "def"}),
                change_reason: "added dual-OS CI".into(),
                changed_by: "human".into(),
            })
            .unwrap();
        assert_eq!(v2.id, v1.id);
        assert_eq!(v2.revision, 2);

        let versions = store.list_kb_item_versions(&v1.id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].revision, 2);
        assert_eq!(versions[1].revision, 1);
        assert_eq!(versions[1].title, "发版流程");

        let marked = store
            .apply_kb_feedback(&v1.id, HumanFeedback::Stale)
            .unwrap();
        assert!(marked.needs_review);
        let helped = store
            .apply_kb_feedback(&v1.id, HumanFeedback::Helpful)
            .unwrap();
        assert!(!helped.needs_review);
        assert_eq!(helped.helpful_count, 1);
    }

    #[test]
    fn portable_export_physically_excludes_local_private_data_and_roundtrips() {
        let src = FuliStore::open_in_memory().unwrap();
        let agent = src.create_agent("FULI", "核心重写", "zh-CN", "").unwrap();
        src.bind_agent(
            &agent.id,
            BindingKind::GitRemote,
            "git@github.com:JevonsCode/fuli.git",
            BindingRole::Own,
            "origin",
        )
        .unwrap();
        src.bind_agent(
            &agent.id,
            BindingKind::DirPath,
            r"T:\secret-local\fuli",
            BindingRole::Own,
            "local-win",
        )
        .unwrap();
        src.upsert_session(
            "claude-code",
            "priv-sess-1",
            Some(&agent.id),
            None,
            r"T:\secret-local\fuli",
            Some("private chat"),
        )
        .unwrap();
        src.upsert_rule_or_pref(UpsertRuleInput {
            id: None,
            scope_kind: RuleScope::PersonalGlobal,
            scope_id: String::new(),
            constraint_class: ConstraintClass::HardRule,
            aspect: PreferenceAspect::HardRule,
            pref_key: "ui.shadows".into(),
            authority: RuleAuthority::HumanExplicit,
            status: RuleStatus::Active,
            content: "禁止装饰性阴影".into(),
            rationale: "极简风格".into(),
            applicability: RuleApplicability::default(),
        })
        .unwrap();

        let bundle = src.export_portable_bundle().unwrap();
        let json = serde_json::to_string(&bundle).unwrap();
        // Local path and private session MUST NOT leak into export JSON!
        assert!(!json.contains("secret-local"));
        assert!(!json.contains("priv-sess-1"));
        assert!(json.contains("github.com/jevonscode/fuli"));

        let dst = FuliStore::open_in_memory().unwrap();
        let summary = dst.import_portable_bundle(&bundle, false).unwrap();
        assert_eq!(summary.agents_imported, 1);
        assert_eq!(summary.rules_imported, 1);

        let dst_agents = dst.list_agents(false).unwrap();
        assert_eq!(dst_agents.len(), 1);
        let dst_bindings = dst.list_agent_bindings(&dst_agents[0].id).unwrap();
        assert_eq!(dst_bindings.len(), 1);
        assert_eq!(dst_bindings[0].kind, BindingKind::GitRemote);
    }

    #[test]
    fn v1_importer_deduplicates_entity_and_edge_noise_and_supports_dry_run() {
        let v1_json = r#"{
            "scope": { "name": "潮池账本", "description": "老版本数据" },
            "entities": [
                { "uuid": "e1", "name": "发版流程", "summary": "先跑单测再推 tag", "kind": "runbook", "retrieval_terms": ["release"] }
            ],
            "edges": [
                { "uuid": "r1", "name": "发版流程", "fact": "先跑单测再推 tag" },
                { "uuid": "r2", "name": "预发布端口", "fact": "预发布环境固定使用 8443 端口" }
            ],
            "preferences": [
                { "scope": "personal", "key": "reply.style", "content": "说人话，少废话", "hard": false },
                { "scope": "project", "key": "git.main", "content": "禁止直接推 main 分支", "hard": true }
            ]
        }"#;

        let store = FuliStore::open_in_memory().unwrap();
        let preview = store.import_v1_export_json(v1_json, true).unwrap();
        assert!(preview.dry_run);
        assert_eq!(preview.kb_items_imported, 2);
        assert_eq!(preview.duplicates_skipped, 1);
        assert_eq!(preview.rules_imported, 2);
        assert!(store.list_agents(true).unwrap().is_empty());

        let applied = store.import_v1_export_json(v1_json, false).unwrap();
        assert!(!applied.dry_run);
        assert_eq!(applied.kb_items_imported, 2);
        assert_eq!(applied.duplicates_skipped, 1);
        assert_eq!(applied.rules_imported, 2);

        let agents = store.list_agents(false).unwrap();
        assert_eq!(agents.len(), 1);
        let rules = store
            .resolve_effective_rules(Some(&agents[0].id), None)
            .unwrap();
        assert_eq!(rules.hard_rules.len(), 1);
        assert_eq!(rules.preferences.len(), 1);
    }

    #[test]
    fn workstream_checkpoint_records_compounding_events_and_portfolio_summary() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent = store.create_agent("FULI", "", "zh-CN", "").unwrap();
        let kb = store.primary_kb_for_agent(&agent.id).unwrap().unwrap();
        let item = store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb.id,
                stable_key: None,
                item_type: KbItemType::Experience,
                status: KbItemStatus::Confirmed,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: "Windows PowerShell 5.1 不支持 &&".into(),
                body: "多条命令用换行或分号分隔".into(),
                context_summary: String::new(),
                aliases: vec![],
                evidence: serde_json::json!({}),
                change_reason: "learned".into(),
                changed_by: "human".into(),
            })
            .unwrap();

        let (ws, cp) = store
            .checkpoint_workstream(CheckpointInput {
                workstream_id: None,
                agent_id: agent.id.clone(),
                title: Some("搭建内核".into()),
                status: Some(WorkstreamStatus::Active),
                worktree_path: Some("t:/workspace/fuli".into()),
                branch_name: Some("next".into()),
                goal: "完成 SQLite 不可变内核".into(),
                current_state: "schema 与 CRUD 已完成".into(),
                decisions: vec![DecisionRecord {
                    decision: "单 SQLite WAL 替代 Neo4j".into(),
                    reason: "常驻内存低于 25 MiB".into(),
                }],
                next_steps: vec!["实现双语检索".into()],
                reused_refs: vec![ReusedRef {
                    kind: "kb_item".into(),
                    id: item.id.clone(),
                    rev: 1,
                    note: "脚本编写避坑".into(),
                }],
                source_client: "codex".into(),
                source_session_id: "sess-a".into(),
            })
            .unwrap();

        assert_eq!(cp.seq, 1);
        assert_eq!(ws.head_checkpoint_id.as_deref(), Some(cp.id.as_str()));

        let summary = store.query_portfolio_summary(7).unwrap();
        assert_eq!(summary.total_agents, 1);
        assert_eq!(summary.active_workstreams, 1);
        assert_eq!(summary.compounding_events_count, 1);
        assert_eq!(summary.recent_checkpoints.len(), 1);
        assert_eq!(summary.weekly_compounding_series.len(), 7);
        assert_eq!(*summary.weekly_compounding_series.last().unwrap(), 1);

        let updated_item = store.get_kb_item(&item.id).unwrap().unwrap();
        assert_eq!(updated_item.reuse_count, 1);

        // Verify dir_path resolution works deterministically too
        store
            .bind_agent(
                &agent.id,
                BindingKind::DirPath,
                r"T:\workspace\fuli-demo",
                BindingRole::Own,
                "demo",
            )
            .unwrap();
        let (res, _) = store
            .resolve_agent_by_cwd(r"T:\workspace\fuli-demo\crates\fuli-store")
            .unwrap();
        match res {
            AgentResolution::Matched { agent: matched, .. } => assert_eq!(matched.id, agent.id),
            other => panic!("expected matched agent, got {other:?}"),
        }
    }
}
