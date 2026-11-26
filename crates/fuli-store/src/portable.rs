use std::collections::{HashMap, HashSet};

use fuli_domain::{
    AgentBinding, AgentKbMount, BindingKind, ConstraintClass, FuliAgent, KbItem, KbItemStatus,
    KbItemType, KbLink, KnowledgeBase, PreferenceAspect, RuleApplicability, RuleAuthority,
    RuleOrPref, RuleScope, RuleStatus, Workflow, Workstream, WorkstreamCheckpoint,
    normalize_name_key, now_rfc3339,
};
use serde::{Deserialize, Serialize};

use crate::error::{StoreError, StoreResult};
use crate::store::{CheckpointInput, FuliStore, UpsertKbItemInput, UpsertRuleInput};

pub const PORTABLE_FORMAT_VERSION: u32 = 1;

/// Privacy-safe portable snapshot of FULI's knowledge, agents, rules, workstreams, and workflows.
/// Physically EXCLUDES local machine-private tables:
/// - `sessions`
/// - `delivery_ledger`
/// - `dir_path` bindings (only `git_remote` bindings are exported!)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortableExportBundle {
    pub format_version: u32,
    pub exported_at: String,
    pub agents: Vec<FuliAgent>,
    pub git_bindings: Vec<AgentBinding>,
    pub knowledge_bases: Vec<KnowledgeBase>,
    pub agent_kb_mounts: Vec<AgentKbMount>,
    pub kb_links: Vec<KbLink>,
    pub kb_items: Vec<KbItem>,
    pub rules_and_prefs: Vec<RuleOrPref>,
    pub workstreams: Vec<Workstream>,
    pub checkpoints: Vec<WorkstreamCheckpoint>,
    pub workflows: Vec<Workflow>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportSummary {
    pub dry_run: bool,
    pub agents_imported: usize,
    pub kbs_imported: usize,
    pub kb_items_imported: usize,
    pub rules_imported: usize,
    pub workstreams_imported: usize,
    pub workflows_imported: usize,
    pub duplicates_skipped: usize,
    pub warnings: Vec<String>,
}

impl FuliStore {
    /// Export all portable personal/project knowledge to JSON while physically stripping
    /// local directory paths, active sessions, and delivery ledger logs.
    pub fn export_portable_bundle(&self) -> StoreResult<PortableExportBundle> {
        let agents = self.list_agents(true)?;
        let mut git_bindings = Vec::new();
        let mut agent_kb_mounts = Vec::new();
        for a in &agents {
            for b in self.list_agent_bindings(&a.id)? {
                if b.kind == BindingKind::GitRemote {
                    git_bindings.push(b);
                }
            }
            agent_kb_mounts.extend(self.list_agent_mounts(&a.id)?);
        }

        let knowledge_bases = self.list_kbs()?;
        let kb_links = self.list_kb_links()?;
        let kb_items = self.list_kb_items(None, None)?;
        let rules_and_prefs = self.list_rules_for_context(None)?;
        let workstreams = self.list_workstreams(None, false)?;
        let mut checkpoints = Vec::new();
        for ws in &workstreams {
            if let Some(cp) = self.latest_checkpoint_for_workstream(&ws.id)? {
                checkpoints.push(cp);
            }
        }
        let workflows = self.list_workflows(None)?;

        Ok(PortableExportBundle {
            format_version: PORTABLE_FORMAT_VERSION,
            exported_at: now_rfc3339(),
            agents,
            git_bindings,
            knowledge_bases,
            agent_kb_mounts,
            kb_links,
            kb_items,
            rules_and_prefs,
            workstreams,
            checkpoints,
            workflows,
        })
    }

    pub fn import_portable_bundle(
        &self,
        bundle: &PortableExportBundle,
        dry_run: bool,
    ) -> StoreResult<ImportSummary> {
        if bundle.format_version != PORTABLE_FORMAT_VERSION {
            return Err(StoreError::InvalidInput(format!(
                "unsupported portable bundle version {}",
                bundle.format_version
            )));
        }

        let mut summary = ImportSummary {
            dry_run,
            ..Default::default()
        };

        let mut agent_id_map: HashMap<String, String> = HashMap::new();
        let mut kb_id_map: HashMap<String, String> = HashMap::new();

        for a in &bundle.agents {
            summary.agents_imported += 1;
            if !dry_run {
                let created =
                    self.create_agent(&a.name, &a.description, &a.reply_lang, &a.persona_note)?;
                agent_id_map.insert(a.id.clone(), created.id);
            }
        }

        for kb in &bundle.knowledge_bases {
            summary.kbs_imported += 1;
            if !dry_run {
                let created =
                    self.create_kb(&kb.name, &kb.description, &kb.default_lang, kb.read_only)?;
                kb_id_map.insert(kb.id.clone(), created.id);
            }
        }

        if !dry_run {
            for b in &bundle.git_bindings {
                if b.kind == BindingKind::GitRemote
                    && let Some(mapped_agent) = agent_id_map.get(&b.agent_id)
                {
                    let _ = self.bind_agent(
                        mapped_agent,
                        BindingKind::GitRemote,
                        &b.canonical_key,
                        b.role,
                        &b.label,
                    );
                }
            }
            for m in &bundle.agent_kb_mounts {
                if let (Some(aid), Some(kid)) =
                    (agent_id_map.get(&m.agent_id), kb_id_map.get(&m.kb_id))
                {
                    let _ = self.mount_kb_to_agent(aid, kid, m.mount_role);
                }
            }
            for link in &bundle.kb_links {
                if let (Some(from_id), Some(to_id)) = (
                    kb_id_map.get(&link.from_kb_id),
                    kb_id_map.get(&link.to_kb_id),
                ) {
                    let _ = self.upsert_kb_link(
                        from_id,
                        to_id,
                        link.relation_type,
                        link.authority,
                        link.weight,
                        &link.rationale,
                    );
                }
            }
        }

        for item in &bundle.kb_items {
            summary.kb_items_imported += 1;
            if !dry_run && let Some(kid) = kb_id_map.get(&item.kb_id) {
                self.upsert_kb_item(UpsertKbItemInput {
                    id: None,
                    kb_id: kid.clone(),
                    stable_key: item.stable_key.clone(),
                    item_type: item.item_type,
                    status: item.status,
                    lang: item.lang.clone(),
                    translation_of_id: None,
                    title: item.title.clone(),
                    body: item.body.clone(),
                    context_summary: item.context_summary.clone(),
                    aliases: item.aliases.clone(),
                    evidence: item.evidence.clone(),
                    change_reason: "portable import".into(),
                    changed_by: "import".into(),
                })?;
            }
        }

        for rule in &bundle.rules_and_prefs {
            summary.rules_imported += 1;
            if !dry_run {
                let mapped_scope_id = if rule.scope_kind == RuleScope::Agent {
                    agent_id_map
                        .get(&rule.scope_id)
                        .cloned()
                        .unwrap_or_else(|| rule.scope_id.clone())
                } else {
                    String::new()
                };
                self.upsert_rule_or_pref(UpsertRuleInput {
                    id: None,
                    scope_kind: rule.scope_kind,
                    scope_id: mapped_scope_id,
                    constraint_class: rule.constraint_class,
                    aspect: rule.aspect,
                    pref_key: rule.pref_key.clone(),
                    authority: rule.authority,
                    status: rule.status,
                    content: rule.content.clone(),
                    rationale: rule.rationale.clone(),
                    applicability: rule.applicability.clone(),
                })?;
            }
        }

        for ws in &bundle.workstreams {
            summary.workstreams_imported += 1;
            if !dry_run && let Some(aid) = agent_id_map.get(&ws.agent_id) {
                let cp = bundle.checkpoints.iter().find(|c| c.workstream_id == ws.id);
                self.checkpoint_workstream(CheckpointInput {
                    workstream_id: None,
                    agent_id: aid.clone(),
                    title: Some(ws.title.clone()),
                    status: Some(ws.status),
                    worktree_path: None, // Never carry raw machine paths across devices
                    branch_name: Some(ws.branch_name.clone()),
                    goal: cp
                        .map(|c| c.goal.clone())
                        .unwrap_or_else(|| ws.title.clone()),
                    current_state: cp.map(|c| c.current_state.clone()).unwrap_or_default(),
                    decisions: cp.map(|c| c.decisions.clone()).unwrap_or_default(),
                    next_steps: cp.map(|c| c.next_steps.clone()).unwrap_or_default(),
                    reused_refs: Vec::new(),
                    source_client: "import".into(),
                    source_session_id: String::new(),
                })?;
            }
        }

        for wf in &bundle.workflows {
            summary.workflows_imported += 1;
            if !dry_run && let Some(aid) = agent_id_map.get(&wf.agent_id) {
                self.upsert_workflow(None, aid, &wf.title, &wf.summary, &wf.steps, wf.status)?;
            }
        }

        Ok(summary)
    }

    /// One-time clean importer for legacy FULI v0.29 (`scope_export.py`) JSON exports.
    /// Deduplicates v1's Neo4j `Entity` + `RELATES_TO` dual-storage noise, maps `Project`
    /// scopes to `FULI Agent` + primary `KnowledgeBase`, and migrates preferences/rules cleanly.
    pub fn import_v1_export_json(
        &self,
        raw_json: &str,
        dry_run: bool,
    ) -> StoreResult<ImportSummary> {
        let root: serde_json::Value = serde_json::from_str(raw_json)?;
        let mut summary = ImportSummary {
            dry_run,
            ..Default::default()
        };

        let project_name = root
            .pointer("/scope/name")
            .or_else(|| root.get("project_name"))
            .or_else(|| root.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("迁移项目");
        let project_desc = root
            .pointer("/scope/description")
            .and_then(|v| v.as_str())
            .unwrap_or("从旧版 FULI 导入");

        let (agent_id, kb_id) = if dry_run {
            summary.agents_imported += 1;
            summary.kbs_imported += 1;
            ("dry-agent".to_string(), "dry-kb".to_string())
        } else {
            let agent = self.create_agent(project_name, project_desc, "zh-CN", "")?;
            let kb = self
                .primary_kb_for_agent(&agent.id)?
                .ok_or_else(|| StoreError::NotFound("primary kb".into()))?;
            summary.agents_imported += 1;
            summary.kbs_imported += 1;
            (agent.id, kb.id)
        };

        let mut seen_fingerprints: HashSet<String> = HashSet::new();

        // 1. Entities / Knowledge items
        let entity_arrays = [
            root.get("entities"),
            root.get("nodes"),
            root.get("items"),
            root.get("knowledge"),
        ];
        for arr in entity_arrays
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_array())
        {
            for entry in arr {
                let title = entry
                    .get("name")
                    .or_else(|| entry.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let body = entry
                    .get("summary")
                    .or_else(|| entry.get("fact"))
                    .or_else(|| entry.get("body"))
                    .or_else(|| entry.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if title.is_empty() && body.is_empty() {
                    continue;
                }
                let final_title = if title.is_empty() {
                    body.chars().take(48).collect::<String>()
                } else {
                    title.to_string()
                };
                let final_body = if body.is_empty() {
                    final_title.clone()
                } else {
                    body.to_string()
                };

                let fp = normalize_name_key(&format!("{final_title}::{final_body}"));
                if !seen_fingerprints.insert(fp) {
                    summary.duplicates_skipped += 1;
                    continue;
                }

                let aliases: Vec<String> = entry
                    .get("retrieval_terms")
                    .or_else(|| entry.get("aliases"))
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(ToOwned::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();

                let raw_kind = entry
                    .get("kind")
                    .or_else(|| entry.get("category"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let item_type = match raw_kind.to_lowercase().as_str() {
                    "runbook" | "procedure" | "workflow" => KbItemType::Runbook,
                    "decision" => KbItemType::Decision,
                    "experience" | "pitfall" | "lesson" => KbItemType::Experience,
                    _ => KbItemType::Fact,
                };

                summary.kb_items_imported += 1;
                if !dry_run {
                    self.upsert_kb_item(UpsertKbItemInput {
                        id: None,
                        kb_id: kb_id.clone(),
                        stable_key: entry
                            .get("uuid")
                            .or_else(|| entry.get("id"))
                            .and_then(|v| v.as_str())
                            .map(|s| format!("v1:{s}")),
                        item_type,
                        status: KbItemStatus::Confirmed,
                        lang: "zh-CN".into(),
                        translation_of_id: None,
                        title: final_title,
                        body: final_body,
                        context_summary: entry
                            .get("context")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        aliases,
                        evidence: serde_json::json!({ "imported_from": "fuli_v1" }),
                        change_reason: "migrated from FULI v1 export".into(),
                        changed_by: "v1_importer".into(),
                    })?;
                }
            }
        }

        // 2. RELATES_TO edges / facts (deduped against entities above!)
        let fact_arrays = [root.get("edges"), root.get("facts"), root.get("relations")];
        for arr in fact_arrays
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_array())
        {
            for edge in arr {
                let fact = edge
                    .get("fact")
                    .or_else(|| edge.get("content"))
                    .or_else(|| edge.get("summary"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if fact.is_empty() {
                    continue;
                }
                let label = edge
                    .get("name")
                    .or_else(|| edge.get("label"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let is_pref = label.to_lowercase().contains("prefer")
                    || edge
                        .get("entity_type")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| s.eq_ignore_ascii_case("preference"));

                if is_pref {
                    let is_hard = fact.contains("禁止")
                        || fact.contains("必须")
                        || fact.to_lowercase().contains("never")
                        || fact.to_lowercase().contains("must");
                    let pref_key = edge
                        .get("pref_key")
                        .and_then(|v| v.as_str())
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| {
                            format!(
                                "v1.{}",
                                normalize_name_key(if label.is_empty() { "pref" } else { label })
                                    .replace(' ', "_")
                            )
                        });
                    summary.rules_imported += 1;
                    if !dry_run {
                        self.upsert_rule_or_pref(UpsertRuleInput {
                            id: None,
                            scope_kind: RuleScope::Agent,
                            scope_id: agent_id.clone(),
                            constraint_class: if is_hard {
                                ConstraintClass::HardRule
                            } else {
                                ConstraintClass::Preference
                            },
                            aspect: if is_hard {
                                PreferenceAspect::HardRule
                            } else {
                                PreferenceAspect::Taste
                            },
                            pref_key,
                            authority: RuleAuthority::HumanConfirmed,
                            status: RuleStatus::Active,
                            content: fact.to_string(),
                            rationale: "从旧版 FULI 导入".into(),
                            applicability: RuleApplicability::default(),
                        })?;
                    }
                    continue;
                }

                let title: String = if !label.is_empty() && label != "RELATES_TO" {
                    label.to_string()
                } else {
                    fact.chars().take(48).collect()
                };
                let fp = normalize_name_key(&format!("{title}::{fact}"));
                if !seen_fingerprints.insert(fp) {
                    summary.duplicates_skipped += 1;
                    continue;
                }

                summary.kb_items_imported += 1;
                if !dry_run {
                    self.upsert_kb_item(UpsertKbItemInput {
                        id: None,
                        kb_id: kb_id.clone(),
                        stable_key: edge
                            .get("uuid")
                            .and_then(|v| v.as_str())
                            .map(|s| format!("v1_edge:{s}")),
                        item_type: KbItemType::Fact,
                        status: KbItemStatus::Confirmed,
                        lang: "zh-CN".into(),
                        translation_of_id: None,
                        title,
                        body: fact.to_string(),
                        context_summary: String::new(),
                        aliases: Vec::new(),
                        evidence: serde_json::json!({ "imported_from": "fuli_v1_edge" }),
                        change_reason: "migrated from FULI v1 edge".into(),
                        changed_by: "v1_importer".into(),
                    })?;
                }
            }
        }

        // 3. Dedicated preferences array if present
        if let Some(prefs) = root.get("preferences").and_then(|v| v.as_array()) {
            for pref in prefs {
                let content = pref
                    .get("content")
                    .or_else(|| pref.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if content.is_empty() {
                    continue;
                }
                let scope_kind = match pref.get("scope").and_then(|v| v.as_str()) {
                    Some("personal") | Some("global") | Some("personal_global") => {
                        RuleScope::PersonalGlobal
                    }
                    _ => RuleScope::Agent,
                };
                let is_hard = pref.get("hard").and_then(|v| v.as_bool()).unwrap_or(false)
                    || content.contains("禁止")
                    || content.contains("严禁");
                let pref_key = pref
                    .get("key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("v1.general")
                    .to_string();

                summary.rules_imported += 1;
                if !dry_run {
                    self.upsert_rule_or_pref(UpsertRuleInput {
                        id: None,
                        scope_kind,
                        scope_id: if scope_kind == RuleScope::Agent {
                            agent_id.clone()
                        } else {
                            String::new()
                        },
                        constraint_class: if is_hard {
                            ConstraintClass::HardRule
                        } else {
                            ConstraintClass::Preference
                        },
                        aspect: if is_hard {
                            PreferenceAspect::HardRule
                        } else {
                            PreferenceAspect::Taste
                        },
                        pref_key,
                        authority: RuleAuthority::HumanConfirmed,
                        status: RuleStatus::Active,
                        content: content.to_string(),
                        rationale: "从旧版 FULI 偏好导入".into(),
                        applicability: RuleApplicability::default(),
                    })?;
                }
            }
        }

        Ok(summary)
    }
}
