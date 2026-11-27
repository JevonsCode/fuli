use std::collections::{HashMap, HashSet};

use fuli_domain::{
    AgentResolution, ConstraintClass, DeliveryMode, DeliveryRecord, RuleConflict, RuleOrPref,
    RuleScope, SessionControlMode, WorkstreamStatus, detect_remember_signal, new_id, now_rfc3339,
};
use fuli_store::{FuliStore, StoreResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactRuleCard {
    pub id: String,
    pub scope: RuleScope,
    pub class: ConstraintClass,
    pub pref_key: String,
    pub content: String,
    pub rev: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenWorkstreamBrief {
    pub id: String,
    pub title: String,
    pub status: WorkstreamStatus,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub branch: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryContextPacket {
    pub client_id: String,
    pub session_id: String,
    pub context_epoch: i64,
    pub turn_seq: i64,
    pub control_mode: SessionControlMode,
    pub agent_resolution: AgentResolution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_branch: Option<String>,
    /// Hard rules delivered in THIS turn (incremental delta only!).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hard_rules: Vec<CompactRuleCard>,
    /// Soft preferences delivered in THIS turn (incremental delta only!).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preferences: Vec<CompactRuleCard>,
    /// Rule IDs that were previously delivered in this epoch and have since been disabled/removed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_rule_ids: Vec<String>,
    /// Unresolved rule conflicts that require human decision.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rule_conflicts: Vec<RuleConflict>,
    /// Brief list of open workstreams (titles only; NEVER auto-injects old history!).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_workstreams: Vec<OpenWorkstreamBrief>,
    /// Active confirmed workflows available for this FULI Agent (names only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_titles: Vec<String>,
    /// Count of rules skipped because they are already live in this session epoch.
    pub dedup_skipped_count: usize,
    pub tokens_sent_est: i64,
    pub tokens_saved_est: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remember_hint: Option<String>,
}

/// Rough cross-lingual token estimator (~1 token per 3 UTF-8 bytes for mixed CJK/ASCII).
pub fn estimate_tokens(text: &str) -> i64 {
    ((text.len() as i64) + 2) / 3
}

/// Compute incremental context delivery for a client turn (`HookPrompt` or `resolve_context`).
///
/// Iron guarantees:
/// 1. Same `(client_id, session_id, context_epoch)` + unchanged rule `revision` => **0 duplicate injection**.
/// 2. After `PreCompact` bumps `context_epoch`, active rules & preferences cleanly re-deliver.
/// 3. If `control_mode == Disabled`, returns an empty silent packet immediately.
/// 4. Old workstreams are listed by title only — never auto-injected without explicit `resume_workstream`.
#[allow(clippy::too_many_arguments)]
pub fn compute_entry_delivery(
    store: &FuliStore,
    client_id: &str,
    session_id: &str,
    cwd: &str,
    explicit_agent_id: Option<&str>,
    work_kind: Option<&str>,
    user_prompt: Option<&str>,
    trigger_kind: &str,
) -> StoreResult<EntryContextPacket> {
    compute_entry_delivery_opts(
        store,
        client_id,
        session_id,
        cwd,
        explicit_agent_id,
        work_kind,
        user_prompt,
        trigger_kind,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn compute_entry_delivery_opts(
    store: &FuliStore,
    client_id: &str,
    session_id: &str,
    cwd: &str,
    explicit_agent_id: Option<&str>,
    work_kind: Option<&str>,
    user_prompt: Option<&str>,
    trigger_kind: &str,
    force_full: bool,
) -> StoreResult<EntryContextPacket> {
    if force_full {
        let _ = store.bump_session_epoch(client_id, session_id)?;
    }
    let (resolution, repo) = if let Some(aid) = explicit_agent_id {
        let repo = fuli_store::detect_repo_at(cwd);
        let res = match store.get_agent(aid)? {
            Some(agent) => AgentResolution::Matched {
                basis: "explicit_agent_id".into(),
                agent,
            },
            None => AgentResolution::Unmatched,
        };
        (res, repo)
    } else {
        store.resolve_agent_by_cwd(cwd)?
    };

    let matched_agent_id = match &resolution {
        AgentResolution::Matched { agent, .. } => Some(agent.id.clone()),
        _ => None,
    };

    let session = store.upsert_session(
        client_id,
        session_id,
        matched_agent_id.as_deref(),
        None,
        cwd,
        None,
    )?;

    let turn_seq = next_turn_seq(store, client_id, session_id, session.context_epoch)?;

    if session.control_mode == SessionControlMode::Disabled {
        return Ok(EntryContextPacket {
            client_id: client_id.to_string(),
            session_id: session_id.to_string(),
            context_epoch: session.context_epoch,
            turn_seq,
            control_mode: session.control_mode,
            agent_resolution: resolution,
            detected_branch: repo.branch,
            hard_rules: Vec::new(),
            preferences: Vec::new(),
            removed_rule_ids: Vec::new(),
            rule_conflicts: Vec::new(),
            open_workstreams: Vec::new(),
            workflow_titles: Vec::new(),
            dedup_skipped_count: 0,
            tokens_sent_est: 0,
            tokens_saved_est: 0,
            remember_hint: None,
        });
    }

    let resolved_rules = store.resolve_effective_rules(matched_agent_id.as_deref(), work_kind)?;
    let prev_delivered =
        load_delivered_rule_revs(store, client_id, session_id, session.context_epoch)?;

    let mut current_effective_ids: HashSet<String> = HashSet::new();
    let mut hard_rules = Vec::new();
    let mut preferences = Vec::new();
    let mut dedup_skipped_count = 0usize;
    let mut tokens_sent_est = 0i64;
    let mut tokens_saved_est = 0i64;
    let now = now_rfc3339();

    let all_effective: Vec<&RuleOrPref> = resolved_rules
        .hard_rules
        .iter()
        .chain(resolved_rules.preferences.iter())
        .collect();

    for rule in all_effective {
        current_effective_ids.insert(rule.id.clone());
        let tok = estimate_tokens(&rule.content) + 8;
        let already_same_rev = prev_delivered.get(&rule.id).copied() == Some(rule.revision);

        if already_same_rev {
            dedup_skipped_count += 1;
            tokens_saved_est += tok;
            store.insert_delivery_record(&DeliveryRecord {
                id: new_id(),
                client_id: client_id.to_string(),
                session_id: session_id.to_string(),
                context_epoch: session.context_epoch,
                turn_seq,
                trigger_kind: trigger_kind.to_string(),
                target_kind: rule.constraint_class.as_str().to_string(),
                target_id: rule.id.clone(),
                target_revision: rule.revision,
                delivery_mode: DeliveryMode::SkippedDedup,
                tokens_est: tok,
                reason: "本轮会话已有最新版，自动跳过重复注入".into(),
                created_at: now.clone(),
            })?;
            continue;
        }

        let card = CompactRuleCard {
            id: rule.id.clone(),
            scope: rule.scope_kind,
            class: rule.constraint_class,
            pref_key: rule.pref_key.clone(),
            content: rule.content.clone(),
            rev: rule.revision,
        };
        tokens_sent_est += tok;
        match rule.constraint_class {
            ConstraintClass::HardRule => hard_rules.push(card),
            ConstraintClass::Preference => preferences.push(card),
        }

        let reason = if prev_delivered.contains_key(&rule.id) {
            "规则已更新为新版本，增量下发"
        } else {
            "本轮会话首次生效，完整下发"
        };
        store.insert_delivery_record(&DeliveryRecord {
            id: new_id(),
            client_id: client_id.to_string(),
            session_id: session_id.to_string(),
            context_epoch: session.context_epoch,
            turn_seq,
            trigger_kind: trigger_kind.to_string(),
            target_kind: rule.constraint_class.as_str().to_string(),
            target_id: rule.id.clone(),
            target_revision: rule.revision,
            delivery_mode: DeliveryMode::Full,
            tokens_est: tok,
            reason: reason.into(),
            created_at: now.clone(),
        })?;
    }

    // Detect any previously delivered rules that were removed/disabled since last turn
    let mut removed_rule_ids = Vec::new();
    for (prev_id, prev_rev) in &prev_delivered {
        if !current_effective_ids.contains(prev_id) {
            removed_rule_ids.push(prev_id.clone());
            store.insert_delivery_record(&DeliveryRecord {
                id: new_id(),
                client_id: client_id.to_string(),
                session_id: session_id.to_string(),
                context_epoch: session.context_epoch,
                turn_seq,
                trigger_kind: trigger_kind.to_string(),
                target_kind: "rule".into(),
                target_id: prev_id.clone(),
                target_revision: *prev_rev,
                delivery_mode: DeliveryMode::DeltaRemoved,
                tokens_est: 6,
                reason: "该规矩已被撤销或改写，通知客户端失效".into(),
                created_at: now.clone(),
            })?;
        }
    }
    removed_rule_ids.sort();

    // Open workstream titles (never auto-inject full checkpoints!)
    let open_workstreams = if let Some(ref aid) = matched_agent_id {
        store
            .list_workstreams(Some(aid), true)?
            .into_iter()
            .take(5)
            .map(|w| OpenWorkstreamBrief {
                id: w.id,
                title: w.title,
                status: w.status,
                branch: w.branch_name,
                updated_at: w.updated_at,
            })
            .collect()
    } else {
        Vec::new()
    };

    let workflow_titles = if let Some(ref aid) = matched_agent_id {
        store
            .list_workflows(Some(aid))?
            .into_iter()
            .filter(|wf| wf.status == fuli_domain::WorkflowStatus::Active)
            .map(|wf| wf.title)
            .collect()
    } else {
        Vec::new()
    };

    let remember_hint = user_prompt.and_then(|text| match detect_remember_signal(text) {
        fuli_domain::RememberSignal::ExplicitRemember => {
            Some("用户明确要求记住一条规矩或事实，完成后请调用 save_rule_or_preference 或 propose_knowledge 落盘。".into())
        }
        fuli_domain::RememberSignal::RepeatReminder => {
            Some("用户提醒你重复犯了旧错，请先检索记忆确认已有规矩，必要时提议升格为红线规矩。".into())
        }
        fuli_domain::RememberSignal::None => None,
    });

    Ok(EntryContextPacket {
        client_id: client_id.to_string(),
        session_id: session_id.to_string(),
        context_epoch: session.context_epoch,
        turn_seq,
        control_mode: session.control_mode,
        agent_resolution: resolution,
        detected_branch: repo.branch,
        hard_rules,
        preferences,
        removed_rule_ids,
        rule_conflicts: resolved_rules.conflicts,
        open_workstreams,
        workflow_titles,
        dedup_skipped_count,
        tokens_sent_est,
        tokens_saved_est,
        remember_hint,
    })
}

/// Handle `PreCompact` event: bump `context_epoch` so the next turn cleanly re-delivers
/// active hard rules and preferences into the freshly compacted context window.
pub fn handle_pre_compact(
    store: &FuliStore,
    client_id: &str,
    session_id: &str,
) -> StoreResult<i64> {
    store.bump_session_epoch(client_id, session_id)
}

/// Record an on-demand `search_knowledge` delivery into `delivery_ledger` so the
/// Delivery Inspector shows both Hook rule injections AND knowledge search retrievals.
pub fn record_search_delivery(
    store: &FuliStore,
    client_id: &str,
    session_id: &str,
    query: &str,
    returned_ids: &[(String, i64)],
    used_bytes: usize,
) -> StoreResult<()> {
    let sess = store.upsert_session(client_id, session_id, None, None, "", None)?;
    let turn_seq = next_turn_seq(store, client_id, session_id, sess.context_epoch)?;
    let now = now_rfc3339();
    let per_item_tok = if returned_ids.is_empty() {
        0
    } else {
        ((used_bytes as i64) / 3 / (returned_ids.len() as i64)).max(1)
    };
    for (item_id, rev) in returned_ids {
        store.insert_delivery_record(&DeliveryRecord {
            id: new_id(),
            client_id: client_id.to_string(),
            session_id: session_id.to_string(),
            context_epoch: sess.context_epoch,
            turn_seq,
            trigger_kind: "mcp_search".into(),
            target_kind: "kb_item".into(),
            target_id: item_id.clone(),
            target_revision: *rev,
            delivery_mode: DeliveryMode::Full,
            tokens_est: per_item_tok,
            reason: format!(
                "按需检索「{}」命中交付",
                query.chars().take(32).collect::<String>()
            ),
            created_at: now.clone(),
        })?;
    }
    Ok(())
}

fn next_turn_seq(
    store: &FuliStore,
    client_id: &str,
    session_id: &str,
    context_epoch: i64,
) -> StoreResult<i64> {
    let seq: i64 = store.connection().query_row(
        "SELECT COALESCE(MAX(turn_seq), 0) + 1
         FROM delivery_ledger
         WHERE client_id = ?1 AND session_id = ?2 AND context_epoch = ?3",
        params![client_id, session_id, context_epoch],
        |r| r.get(0),
    )?;
    Ok(seq)
}

/// Reconstruct the latest active revision of each rule/pref delivered in the current epoch.
fn load_delivered_rule_revs(
    store: &FuliStore,
    client_id: &str,
    session_id: &str,
    context_epoch: i64,
) -> StoreResult<HashMap<String, i64>> {
    let mut stmt = store.connection().prepare(
        "SELECT target_id, target_revision, delivery_mode
         FROM delivery_ledger
         WHERE client_id = ?1 AND session_id = ?2 AND context_epoch = ?3
           AND target_kind IN ('hard_rule', 'preference', 'rule')
         ORDER BY turn_seq ASC, created_at ASC",
    )?;
    let rows = stmt.query_map(params![client_id, session_id, context_epoch], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;

    let mut state: HashMap<String, i64> = HashMap::new();
    for entry in rows {
        let (target_id, rev, mode) = entry?;
        match mode.as_str() {
            "full" => {
                state.insert(target_id, rev);
            }
            "delta_removed" => {
                state.remove(&target_id);
            }
            _ => {}
        }
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fuli_domain::{
        BindingKind, BindingRole, PreferenceAspect, RuleApplicability, RuleAuthority, RuleStatus,
    };
    use fuli_store::UpsertRuleInput;

    #[test]
    fn zero_duplicate_injection_within_epoch_and_clean_redelivery_after_pre_compact() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent = store.create_agent("FULI", "", "zh-CN", "").unwrap();
        store
            .bind_agent(
                &agent.id,
                BindingKind::DirPath,
                "t:/workspace/fuli",
                BindingRole::Own,
                "main",
            )
            .unwrap();
        let rule = store
            .upsert_rule_or_pref(UpsertRuleInput {
                id: None,
                scope_kind: RuleScope::Agent,
                scope_id: agent.id.clone(),
                constraint_class: ConstraintClass::HardRule,
                aspect: PreferenceAspect::HardRule,
                pref_key: "ui.shadows".into(),
                authority: RuleAuthority::HumanExplicit,
                status: RuleStatus::Active,
                content: "所有卡片禁止装饰性阴影".into(),
                rationale: "保持干净简洁".into(),
                applicability: RuleApplicability::default(),
            })
            .unwrap();

        // Turn 1: full delivery
        let t1 = compute_entry_delivery(
            &store,
            "claude-code",
            "sess-1",
            "t:/workspace/fuli",
            None,
            None,
            None,
            "hook_prompt",
        )
        .unwrap();
        assert_eq!(t1.hard_rules.len(), 1);
        assert_eq!(t1.dedup_skipped_count, 0);
        assert_eq!(t1.context_epoch, 0);

        // Turn 2: same epoch, unchanged revision => ZERO duplicate injection!
        let t2 = compute_entry_delivery(
            &store,
            "claude-code",
            "sess-1",
            "t:/workspace/fuli",
            None,
            None,
            None,
            "hook_prompt",
        )
        .unwrap();
        assert!(t2.hard_rules.is_empty());
        assert_eq!(t2.dedup_skipped_count, 1);
        assert!(t2.tokens_saved_est > 0);

        // Turn 3 after PreCompact: context_epoch bumps to 1 => cleanly re-delivers!
        let new_epoch = handle_pre_compact(&store, "claude-code", "sess-1").unwrap();
        assert_eq!(new_epoch, 1);
        let t3 = compute_entry_delivery(
            &store,
            "claude-code",
            "sess-1",
            "t:/workspace/fuli",
            None,
            None,
            None,
            "hook_prompt",
        )
        .unwrap();
        assert_eq!(t3.context_epoch, 1);
        assert_eq!(t3.hard_rules.len(), 1);
        assert_eq!(t3.dedup_skipped_count, 0);

        // Disable rule => Turn 4 emits delta_removed!
        store.disable_rule(&rule.id).unwrap();
        let t4 = compute_entry_delivery(
            &store,
            "claude-code",
            "sess-1",
            "t:/workspace/fuli",
            None,
            None,
            None,
            "hook_prompt",
        )
        .unwrap();
        assert!(t4.hard_rules.is_empty());
        assert_eq!(t4.removed_rule_ids, vec![rule.id]);
    }
}
