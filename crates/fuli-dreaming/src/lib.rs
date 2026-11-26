use std::collections::{HashMap, HashSet};

use fuli_domain::{KbItem, KbItemStatus, now_rfc3339};
use fuli_store::{FuliStore, StoreResult, tokenize_query_terms};
use serde::{Deserialize, Serialize};

pub const MAX_SUGGESTIONS_PER_SCAN: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DreamingKind {
    MergeDuplicate,
    ReviewStale,
    PromoteReusable,
    ResolveConflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DreamingSuggestion {
    pub kind: DreamingKind,
    pub headline: String,
    pub detail: String,
    pub target_ids: Vec<String>,
    pub action_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DreamingReport {
    pub ran_at: String,
    pub scanned_items: usize,
    pub duplicate_pairs_found: usize,
    pub stale_items_found: usize,
    pub promotion_candidates_found: usize,
    pub rule_conflicts_found: usize,
    /// Capped at `<= 5` high-value, plain-language suggestions so the human is never spammed.
    pub suggestions: Vec<DreamingSuggestion>,
}

/// Layer-1 zero-model periodic curation scan (`Dreaming`).
/// Runs purely in local Rust over SQLite in milliseconds (0 LLM tokens, never silently
/// modifies active rules or confirmed knowledge).
pub fn run_layer1_scan(store: &FuliStore) -> StoreResult<DreamingReport> {
    let items = store.list_kb_items(None, Some(KbItemStatus::Confirmed))?;
    let conflicts = store.list_all_rule_conflicts()?;

    let mut suggestions: Vec<DreamingSuggestion> = Vec::new();

    // 1. Active rule conflicts always take highest priority
    for conflict in &conflicts {
        if suggestions.len() < MAX_SUGGESTIONS_PER_SCAN {
            suggestions.push(DreamingSuggestion {
                kind: DreamingKind::ResolveConflict,
                headline: format!("发现规则冲突：{}", conflict.pref_key),
                detail: conflict.reason.clone(),
                target_ids: conflict.candidates.iter().map(|r| r.id.clone()).collect(),
                action_hint: "去「今天 · 等你拍板」一键二选一".into(),
            });
        }
    }

    // 2. Stale / needs_review items
    let stale_items: Vec<&KbItem> = items.iter().filter(|i| i.needs_review).collect();
    for item in &stale_items {
        if suggestions.len() < MAX_SUGGESTIONS_PER_SCAN {
            suggestions.push(DreamingSuggestion {
                kind: DreamingKind::ReviewStale,
                headline: format!("「{}」可能已经过时", item.title),
                detail: "最近被标记为需复核，检索时已自动降权 70%，确认最新做法或直接废弃。".into(),
                target_ids: vec![item.id.clone()],
                action_hint: "确认仍有效或一键废弃".into(),
            });
        }
    }

    // 3. Near-duplicate detection within the same KB via Jaccard similarity over bilingual tokens
    let mut by_kb: HashMap<&str, Vec<(&KbItem, HashSet<String>)>> = HashMap::new();
    for item in &items {
        let mut toks: HashSet<String> = tokenize_query_terms(&item.title).into_iter().collect();
        toks.extend(tokenize_query_terms(&item.body));
        by_kb
            .entry(item.kb_id.as_str())
            .or_default()
            .push((item, toks));
    }

    let mut duplicate_pairs_found = 0usize;
    for group in by_kb.values() {
        for i in 0..group.len() {
            for j in (i + 1)..group.len() {
                let (a, toks_a) = &group[i];
                let (b, toks_b) = &group[j];
                let sim = jaccard(toks_a, toks_b);
                if sim >= 0.55 {
                    duplicate_pairs_found += 1;
                    if suggestions.len() < MAX_SUGGESTIONS_PER_SCAN {
                        suggestions.push(DreamingSuggestion {
                            kind: DreamingKind::MergeDuplicate,
                            headline: format!("两条记录高度相似：「{}」和「{}」", a.title, b.title),
                            detail: format!(
                                "内容重合度约 {}%，合并成一条可以避免 AI 检索时拿到重复上下文。",
                                (sim * 100.0).round() as u32
                            ),
                            target_ids: vec![a.id.clone(), b.id.clone()],
                            action_hint: "保留较新的一条，废弃重复旧条".into(),
                        });
                    }
                }
            }
        }
    }

    // 4. High-reuse / high-helpful items worth promoting to reusable Workflow or global rule
    let mut promotion_candidates_found = 0usize;
    for item in &items {
        if !item.needs_review && (item.reuse_count >= 3 || item.helpful_count >= 2) {
            promotion_candidates_found += 1;
            if suggestions.len() < MAX_SUGGESTIONS_PER_SCAN {
                suggestions.push(DreamingSuggestion {
                    kind: DreamingKind::PromoteReusable,
                    headline: format!("「{}」已经帮你省心多次", item.title),
                    detail: format!(
                        "累计复用 {} 次、点赞 {} 次，可以考虑沉淀为固定工作流或长期规矩。",
                        item.reuse_count, item.helpful_count
                    ),
                    target_ids: vec![item.id.clone()],
                    action_hint: "升格为常用工作流或长期偏好".into(),
                });
            }
        }
    }

    Ok(DreamingReport {
        ran_at: now_rfc3339(),
        scanned_items: items.len(),
        duplicate_pairs_found,
        stale_items_found: stale_items.len(),
        promotion_candidates_found,
        rule_conflicts_found: conflicts.len(),
        suggestions,
    })
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count();
    let union = a.union(b).count();
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fuli_domain::{HumanFeedback, KbItemType};
    use fuli_store::UpsertKbItemInput;

    #[test]
    fn layer1_dreaming_finds_duplicates_stale_and_high_reuse_without_mutating_data() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent = store.create_agent("FULI", "", "zh-CN", "").unwrap();
        let kb = store.primary_kb_for_agent(&agent.id).unwrap().unwrap();

        let dup1 = store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb.id.clone(),
                stable_key: None,
                item_type: KbItemType::Runbook,
                status: KbItemStatus::Confirmed,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: "Windows 发版前检查".into(),
                body: "运行 cargo test 和 clippy 检查双平台 CI 状态".into(),
                context_summary: String::new(),
                aliases: vec![],
                evidence: serde_json::json!({}),
                change_reason: "seed".into(),
                changed_by: "test".into(),
            })
            .unwrap();
        let _dup2 = store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb.id.clone(),
                stable_key: None,
                item_type: KbItemType::Runbook,
                status: KbItemStatus::Confirmed,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: "Windows 发版前检查步骤".into(),
                body: "运行 cargo test 和 clippy 检查双平台 CI".into(),
                context_summary: String::new(),
                aliases: vec![],
                evidence: serde_json::json!({}),
                change_reason: "seed".into(),
                changed_by: "test".into(),
            })
            .unwrap();
        let stale = store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb.id,
                stable_key: None,
                item_type: KbItemType::Fact,
                status: KbItemStatus::Confirmed,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: "旧版 Neo4j 端口".into(),
                body: "默认连接 bolt://localhost:7687".into(),
                context_summary: String::new(),
                aliases: vec![],
                evidence: serde_json::json!({}),
                change_reason: "seed".into(),
                changed_by: "test".into(),
            })
            .unwrap();

        store
            .apply_kb_feedback(&stale.id, HumanFeedback::Stale)
            .unwrap();
        store
            .apply_kb_feedback(&dup1.id, HumanFeedback::Helpful)
            .unwrap();
        store
            .apply_kb_feedback(&dup1.id, HumanFeedback::Helpful)
            .unwrap();

        let report = run_layer1_scan(&store).unwrap();
        assert_eq!(report.scanned_items, 3);
        assert_eq!(report.duplicate_pairs_found, 1);
        assert_eq!(report.stale_items_found, 1);
        assert_eq!(report.promotion_candidates_found, 1);
        assert!(report.suggestions.len() <= MAX_SUGGESTIONS_PER_SCAN);
        assert!(
            report
                .suggestions
                .iter()
                .any(|s| s.kind == DreamingKind::MergeDuplicate)
        );
        assert!(
            report
                .suggestions
                .iter()
                .any(|s| s.kind == DreamingKind::ReviewStale)
        );
    }
}
