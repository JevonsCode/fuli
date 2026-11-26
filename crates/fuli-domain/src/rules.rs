use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::identity::normalize_name_key;
use crate::model::{ConstraintClass, RuleOrPref, RuleScope, RuleStatus};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleConflict {
    pub pref_key: String,
    pub reason: String,
    pub candidates: Vec<RuleOrPref>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedRules {
    pub hard_rules: Vec<RuleOrPref>,
    pub preferences: Vec<RuleOrPref>,
    pub conflicts: Vec<RuleConflict>,
    pub overridden_global_ids: Vec<String>,
    pub suppressed_soft_ids: Vec<String>,
    pub excluded_by_scope_count: usize,
}

/// Deterministic two-track rule & preference resolver:
///
/// 1. Only `status == Active` AND `authority.is_human_authorized()` entries take effect.
///    AI proposals (`Pending` / `AiProposal`) NEVER silently enter effective rules.
/// 2. Entries with structured `applicability.work_kinds` apply only when `work_kind` matches.
/// 3. **Track 1 (`HardRule`)**:
///    - No soft `Preference` can EVER override any `HardRule`.
///    - If multiple `HardRule` entries share the same `pref_key` with distinct content
///      (whether personal-global vs project, or two within the same scope), BOTH are withheld
///      into `conflicts` with a plain-language explanation so the human chooses.
/// 4. **Track 2 (`Preference`)**:
///    - Suppressed if an active `HardRule` already governs the same `pref_key`.
///    - Otherwise a project (`Agent`) preference refines/overrides a `PersonalGlobal`
///      preference on the same `pref_key`.
///    - Two distinct active preferences within the exact same scope and `pref_key` also
///      surface in `conflicts`.
pub fn resolve_rules_and_prefs(items: &[RuleOrPref], work_kind: Option<&str>) -> ResolvedRules {
    let mut out = ResolvedRules::default();

    let mut hard_by_key: BTreeMap<String, Vec<RuleOrPref>> = BTreeMap::new();
    let mut soft_by_key: BTreeMap<String, Vec<RuleOrPref>> = BTreeMap::new();

    for item in items {
        if item.status != RuleStatus::Active || !item.authority.is_human_authorized() {
            continue;
        }
        if !item.applicability.matches(work_kind) {
            out.excluded_by_scope_count += 1;
            continue;
        }
        match item.constraint_class {
            ConstraintClass::HardRule => {
                hard_by_key
                    .entry(item.pref_key.clone())
                    .or_default()
                    .push(item.clone());
            }
            ConstraintClass::Preference => {
                soft_by_key
                    .entry(item.pref_key.clone())
                    .or_default()
                    .push(item.clone());
            }
        }
    }

    let mut hard_governed_keys: HashSet<String> = HashSet::new();

    for (key, mut group) in hard_by_key {
        hard_governed_keys.insert(key.clone());
        group.sort_by(|a, b| a.id.cmp(&b.id));
        let distinct_contents: HashSet<String> = group
            .iter()
            .map(|r| normalize_name_key(&r.content))
            .collect();
        if distinct_contents.len() > 1 {
            out.conflicts.push(RuleConflict {
                pref_key: key,
                reason: "两条红线规矩内容冲突，需要你二选一。".to_string(),
                candidates: group,
            });
        } else if let Some(first) = group.into_iter().next() {
            out.hard_rules.push(first);
        }
    }

    for (key, mut group) in soft_by_key {
        if hard_governed_keys.contains(&key) {
            for soft in group {
                out.suppressed_soft_ids.push(soft.id);
            }
            continue;
        }

        group.sort_by(|a, b| a.id.cmp(&b.id));
        let (agent_prefs, global_prefs): (Vec<_>, Vec<_>) = group
            .into_iter()
            .partition(|r| r.scope_kind == RuleScope::Agent);

        let active_layer = if !agent_prefs.is_empty() {
            for g in global_prefs {
                out.overridden_global_ids.push(g.id);
            }
            agent_prefs
        } else {
            global_prefs
        };

        let distinct_contents: HashSet<String> = active_layer
            .iter()
            .map(|r| normalize_name_key(&r.content))
            .collect();
        if distinct_contents.len() > 1 {
            out.conflicts.push(RuleConflict {
                pref_key: key,
                reason: "同一范围内存在两条不一致的偏好，需要你确认留哪条。".to_string(),
                candidates: active_layer,
            });
        } else if let Some(first) = active_layer.into_iter().next() {
            out.preferences.push(first);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PreferenceAspect, RuleApplicability, RuleAuthority};

    fn sample_rule(
        id: &str,
        scope: RuleScope,
        class: ConstraintClass,
        key: &str,
        content: &str,
        authority: RuleAuthority,
        status: RuleStatus,
    ) -> RuleOrPref {
        RuleOrPref {
            id: id.into(),
            scope_kind: scope,
            scope_id: if scope == RuleScope::Agent {
                "agent-fuli".into()
            } else {
                String::new()
            },
            constraint_class: class,
            aspect: if class == ConstraintClass::HardRule {
                PreferenceAspect::HardRule
            } else {
                PreferenceAspect::Taste
            },
            pref_key: key.into(),
            authority,
            status,
            content: content.into(),
            rationale: String::new(),
            applicability: RuleApplicability::default(),
            revision: 1,
            created_at: "2026-11-27T00:00:00Z".into(),
            updated_at: "2026-11-27T00:00:00Z".into(),
        }
    }

    #[test]
    fn soft_preference_can_never_override_hard_rule() {
        let items = vec![
            sample_rule(
                "r1",
                RuleScope::Agent,
                ConstraintClass::HardRule,
                "ui.shadows",
                "禁止装饰性阴影",
                RuleAuthority::HumanExplicit,
                RuleStatus::Active,
            ),
            sample_rule(
                "r2",
                RuleScope::Agent,
                ConstraintClass::Preference,
                "ui.shadows",
                "卡片加柔和投影",
                RuleAuthority::HumanConfirmed,
                RuleStatus::Active,
            ),
        ];

        let res = resolve_rules_and_prefs(&items, None);
        assert_eq!(res.hard_rules.len(), 1);
        assert_eq!(res.hard_rules[0].id, "r1");
        assert!(res.preferences.is_empty());
        assert_eq!(res.suppressed_soft_ids, vec!["r2"]);
        assert!(res.conflicts.is_empty());
    }

    #[test]
    fn conflicting_hard_rules_surface_explicitly_without_silent_winner() {
        let items = vec![
            sample_rule(
                "r1",
                RuleScope::PersonalGlobal,
                ConstraintClass::HardRule,
                "code.lang",
                "全部中文注释",
                RuleAuthority::HumanExplicit,
                RuleStatus::Active,
            ),
            sample_rule(
                "r2",
                RuleScope::Agent,
                ConstraintClass::HardRule,
                "code.lang",
                "公开源码英文注释",
                RuleAuthority::HumanExplicit,
                RuleStatus::Active,
            ),
        ];

        let res = resolve_rules_and_prefs(&items, None);
        assert!(res.hard_rules.is_empty());
        assert_eq!(res.conflicts.len(), 1);
        assert_eq!(res.conflicts[0].candidates.len(), 2);
    }

    #[test]
    fn project_soft_preference_refines_global_and_ignores_ai_proposals() {
        let items = vec![
            sample_rule(
                "g1",
                RuleScope::PersonalGlobal,
                ConstraintClass::Preference,
                "reply.style",
                "简洁直给",
                RuleAuthority::HumanConfirmed,
                RuleStatus::Active,
            ),
            sample_rule(
                "p1",
                RuleScope::Agent,
                ConstraintClass::Preference,
                "reply.style",
                "简洁直给，优先附图",
                RuleAuthority::HumanConfirmed,
                RuleStatus::Active,
            ),
            sample_rule(
                "ai1",
                RuleScope::Agent,
                ConstraintClass::Preference,
                "reply.emoji",
                "多用表情",
                RuleAuthority::AiProposal,
                RuleStatus::Active,
            ),
        ];

        let res = resolve_rules_and_prefs(&items, None);
        assert_eq!(res.preferences.len(), 1);
        assert_eq!(res.preferences[0].id, "p1");
        assert_eq!(res.overridden_global_ids, vec!["g1"]);
    }

    #[test]
    fn scoped_work_kind_prevents_prd_rule_leaking_into_coding() {
        let mut prd_rule = sample_rule(
            "p1",
            RuleScope::Agent,
            ConstraintClass::Preference,
            "prd.format",
            "PRD 必须含竞品对比",
            RuleAuthority::HumanConfirmed,
            RuleStatus::Active,
        );
        prd_rule.applicability.work_kinds = vec!["prd".into()];

        let coding = resolve_rules_and_prefs(&[prd_rule.clone()], Some("coding"));
        assert!(coding.preferences.is_empty());
        assert_eq!(coding.excluded_by_scope_count, 1);

        let prd = resolve_rules_and_prefs(&[prd_rule], Some("prd"));
        assert_eq!(prd.preferences.len(), 1);
    }
}
