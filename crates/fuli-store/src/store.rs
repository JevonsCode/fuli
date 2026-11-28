use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{Duration, Utc};
use fuli_domain::{
    AgentBinding, AgentKbMount, AgentResolution, AuthorizedKb, AutonomyLevel, BindingKind,
    BindingRole, CompoundingEvent, ConstraintClass, DecisionRecord, DeliveryMode, DeliveryRecord,
    FuliAgent, HumanFeedback, KbEdge, KbEdgeType, KbItem, KbItemStatus, KbItemType, KbItemVersion,
    KbLink, KbLinkType, KnowledgeBase, LinkAuthority, MountRole, PortfolioCheckpointBrief,
    PortfolioSummary, PreferenceAspect, ResolvedRules, ReusedRef, RoundtableExchange,
    RuleApplicability, RuleAuthority, RuleOrPref, RuleScope, RuleStatus, SessionControlMode,
    SessionRecord, WakeStatus, Workflow, WorkflowStatus, Workstream, WorkstreamCheckpoint,
    WorkstreamStatus, canonicalize_git_remote, new_id, normalize_dir_path, normalize_name_key,
    now_rfc3339, path_basename, resolve_rules_and_prefs,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{StoreError, StoreResult};
use crate::repo_detect::{DetectedRepo, detect_repo_at};
use crate::schema::initialize_database;
use crate::tokenizer::tokenize_for_index;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertKbItemInput {
    pub id: Option<String>,
    pub kb_id: String,
    pub stable_key: Option<String>,
    pub item_type: KbItemType,
    pub status: KbItemStatus,
    pub lang: String,
    pub translation_of_id: Option<String>,
    pub title: String,
    pub body: String,
    pub context_summary: String,
    pub aliases: Vec<String>,
    pub evidence: serde_json::Value,
    pub change_reason: String,
    pub changed_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertRuleInput {
    pub id: Option<String>,
    pub scope_kind: RuleScope,
    pub scope_id: String,
    pub constraint_class: ConstraintClass,
    pub aspect: PreferenceAspect,
    pub pref_key: String,
    pub authority: RuleAuthority,
    pub status: RuleStatus,
    pub content: String,
    pub rationale: String,
    pub applicability: RuleApplicability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointInput {
    pub workstream_id: Option<String>,
    pub agent_id: String,
    pub title: Option<String>,
    pub status: Option<WorkstreamStatus>,
    pub worktree_path: Option<String>,
    pub branch_name: Option<String>,
    pub goal: String,
    pub current_state: String,
    pub decisions: Vec<DecisionRecord>,
    pub next_steps: Vec<String>,
    pub reused_refs: Vec<ReusedRef>,
    pub source_client: String,
    pub source_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingRow {
    pub item_id: String,
    pub model_id: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingItemsSnapshot {
    pub proposed_items: Vec<KbItem>,
    pub pending_rules: Vec<RuleOrPref>,
    pub proposed_workflows: Vec<Workflow>,
    pub stale_items: Vec<KbItem>,
}

pub struct FuliStore {
    pub(crate) conn: Connection,
    db_path: Option<PathBuf>,
}

impl FuliStore {
    pub fn open_path(path: impl AsRef<Path>) -> StoreResult<Self> {
        let p = path.as_ref();
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(p)?;
        initialize_database(&conn)?;
        Ok(Self {
            conn,
            db_path: Some(p.to_path_buf()),
        })
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        let conn = Connection::open_in_memory()?;
        initialize_database(&conn)?;
        Ok(Self {
            conn,
            db_path: None,
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn db_path(&self) -> Option<&Path> {
        self.db_path.as_deref()
    }

    /// Resolve default per-user pure-local data directory (never touches legacy v0.29 Neo4j dir).
    pub fn default_db_path() -> PathBuf {
        if let Ok(explicit) = std::env::var("FULI_DATA_DIR")
            && !explicit.trim().is_empty()
        {
            return PathBuf::from(explicit).join("fuli.db");
        }
        #[cfg(windows)]
        {
            let base = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            base.join("FULI").join("next").join("fuli.db")
        }
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            home.join("Library")
                .join("Application Support")
                .join("FULI")
                .join("next")
                .join("fuli.db")
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let base = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
                .unwrap_or_else(std::env::temp_dir);
            base.join("fuli").join("next").join("fuli.db")
        }
    }

    // =========================================================================
    // Settings (Autonomy level, UI locale, etc.)
    // =========================================================================

    pub fn get_setting(&self, key: &str) -> StoreResult<Option<String>> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(Into::into)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> StoreResult<()> {
        let now = now_rfc3339();
        self.conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )?;
        Ok(())
    }

    pub fn get_autonomy_level(&self) -> StoreResult<AutonomyLevel> {
        let raw = self.get_setting("autonomy_level")?;
        Ok(match raw.as_deref() {
            Some("assist") => AutonomyLevel::Assist,
            Some("auto_routine") => AutonomyLevel::AutoRoutine,
            _ => AutonomyLevel::Manual,
        })
    }

    pub fn set_autonomy_level(&self, level: AutonomyLevel) -> StoreResult<()> {
        let raw = match level {
            AutonomyLevel::Manual => "manual",
            AutonomyLevel::Assist => "assist",
            AutonomyLevel::AutoRoutine => "auto_routine",
        };
        self.set_setting("autonomy_level", raw)
    }

    // =========================================================================
    // FULI Agents (FLA) & Repo/Dir Bindings
    // =========================================================================

    pub fn create_agent(
        &self,
        name: &str,
        description: &str,
        reply_lang: &str,
        persona_note: &str,
    ) -> StoreResult<FuliAgent> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(StoreError::InvalidInput(
                "agent name cannot be empty".into(),
            ));
        }
        let name_key = normalize_name_key(trimmed);
        if let Some(existing) = self.find_agent_by_name_key(&name_key)? {
            return Ok(existing);
        }

        let id = new_id();
        let now = now_rfc3339();
        let lang = if reply_lang.trim().is_empty() {
            "zh-CN"
        } else {
            reply_lang.trim()
        };

        self.conn.execute(
            "INSERT INTO agents (id, name, name_key, description, reply_lang, persona_note, archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            params![id, trimmed, name_key, description, lang, persona_note, now],
        )?;

        // Automatically create and mount the agent's primary knowledge base.
        let kb = self.create_kb(
            &format!("{trimmed} 知识库"),
            &format!("{trimmed} 的专属知识库"),
            lang,
            false,
        )?;
        self.mount_kb_to_agent(&id, &kb.id, MountRole::Primary)?;

        self.get_agent(&id)?
            .ok_or_else(|| StoreError::NotFound(format!("agent {id}")))
    }

    pub fn get_agent(&self, id: &str) -> StoreResult<Option<FuliAgent>> {
        self.conn
            .query_row(
                "SELECT id, name, name_key, description, reply_lang, persona_note, archived, created_at, updated_at
                 FROM agents WHERE id = ?1",
                [id],
                row_to_agent,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn find_agent_by_name_key(&self, name_key: &str) -> StoreResult<Option<FuliAgent>> {
        self.conn
            .query_row(
                "SELECT id, name, name_key, description, reply_lang, persona_note, archived, created_at, updated_at
                 FROM agents WHERE name_key = ?1",
                [name_key],
                row_to_agent,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_agents(&self, include_archived: bool) -> StoreResult<Vec<FuliAgent>> {
        let sql = if include_archived {
            "SELECT id, name, name_key, description, reply_lang, persona_note, archived, created_at, updated_at
             FROM agents ORDER BY updated_at DESC"
        } else {
            "SELECT id, name, name_key, description, reply_lang, persona_note, archived, created_at, updated_at
             FROM agents WHERE archived = 0 ORDER BY updated_at DESC"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([], row_to_agent)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn bind_agent(
        &self,
        agent_id: &str,
        kind: BindingKind,
        raw_key: &str,
        role: BindingRole,
        label: &str,
    ) -> StoreResult<AgentBinding> {
        let canonical = match kind {
            BindingKind::GitRemote => canonicalize_git_remote(raw_key).ok_or_else(|| {
                StoreError::InvalidInput(format!("invalid git remote: {raw_key}"))
            })?,
            BindingKind::DirPath => normalize_dir_path(&real_dir_path(raw_key)),
        };
        let id = new_id();
        let now = now_rfc3339();
        self.conn.execute(
            "INSERT INTO agent_bindings (id, agent_id, kind, canonical_key, role, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(agent_id, kind, canonical_key) DO UPDATE SET role = excluded.role, label = excluded.label",
            params![id, agent_id, kind.as_str(), canonical, role.as_str(), label, now],
        )?;
        self.conn
            .query_row(
                "SELECT id, agent_id, kind, canonical_key, role, label, created_at
                 FROM agent_bindings WHERE agent_id = ?1 AND kind = ?2 AND canonical_key = ?3",
                params![agent_id, kind.as_str(), canonical],
                row_to_binding,
            )
            .map_err(Into::into)
    }

    pub fn list_agent_bindings(&self, agent_id: &str) -> StoreResult<Vec<AgentBinding>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, agent_id, kind, canonical_key, role, label, created_at
             FROM agent_bindings WHERE agent_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([agent_id], row_to_binding)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Deterministic local resolution order (never guesses across multiple owners):
    /// 1. Git remote canonical match (`role = 'own'`) — automatically unifies all worktrees!
    /// 2. Longest matching `dir_path` prefix (`role = 'own'`)
    /// 3. Exact directory basename == agent `name_key`
    pub fn resolve_agent_by_cwd(&self, cwd: &str) -> StoreResult<(AgentResolution, DetectedRepo)> {
        let repo = detect_repo_at(cwd);
        let norm_cwd = normalize_dir_path(&real_dir_path(cwd));

        // Step 1: Canonical git remote
        if let Some(ref remote) = repo.git_remote_canonical {
            let matches = self.find_agents_for_binding(BindingKind::GitRemote, remote)?;
            if matches.len() == 1 {
                return Ok((
                    AgentResolution::Matched {
                        basis: format!("git_remote:{remote}"),
                        agent: matches.into_iter().next().unwrap(),
                    },
                    repo,
                ));
            }
            if matches.len() > 1 {
                return Ok((
                    AgentResolution::Ambiguous {
                        reason: format!("多个 FULI Agent 绑定了同一仓库 {remote}，请明确指定。"),
                        candidates: matches,
                    },
                    repo,
                ));
            }
        }

        // Step 2: Longest dir_path prefix
        let mut stmt = self.conn.prepare(
            "SELECT b.canonical_key, a.id, a.name, a.name_key, a.description, a.reply_lang, a.persona_note, a.archived, a.created_at, a.updated_at
             FROM agent_bindings b
             JOIN agents a ON a.id = b.agent_id
             WHERE b.kind = 'dir_path' AND b.role = 'own' AND a.archived = 0",
        )?;
        let rows = stmt.query_map([], |row| {
            let key: String = row.get(0)?;
            let agent = FuliAgent {
                id: row.get(1)?,
                name: row.get(2)?,
                name_key: row.get(3)?,
                description: row.get(4)?,
                reply_lang: row.get(5)?,
                persona_note: row.get(6)?,
                archived: row.get::<_, i64>(7)? != 0,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            };
            Ok((key, agent))
        })?;

        let mut best_len = 0usize;
        let mut best_agents: Vec<FuliAgent> = Vec::new();
        for pair in rows {
            let (bound_dir, agent) = pair?;
            if is_same_or_child_dir(&norm_cwd, &bound_dir) {
                let len = bound_dir.len();
                if len > best_len {
                    best_len = len;
                    best_agents.clear();
                    best_agents.push(agent);
                } else if len == best_len && !best_agents.iter().any(|a| a.id == agent.id) {
                    best_agents.push(agent);
                }
            }
        }

        if best_agents.len() == 1 {
            return Ok((
                AgentResolution::Matched {
                    basis: "dir_path".into(),
                    agent: best_agents.into_iter().next().unwrap(),
                },
                repo,
            ));
        }
        if best_agents.len() > 1 {
            return Ok((
                AgentResolution::Ambiguous {
                    reason: "多个 FULI Agent 绑定了同一目录，请明确指定。".into(),
                    candidates: best_agents,
                },
                repo,
            ));
        }

        // Step 3: Exact repo/dir basename == agent name_key
        let candidate_name = repo
            .repo_root
            .as_deref()
            .and_then(path_basename)
            .or_else(|| path_basename(&norm_cwd));
        if let Some(base) = candidate_name
            && let Some(agent) = self.find_agent_by_name_key(&normalize_name_key(&base))?
            && !agent.archived
        {
            return Ok((
                AgentResolution::Matched {
                    basis: format!("dir_name:{base}"),
                    agent,
                },
                repo,
            ));
        }

        Ok((AgentResolution::Unmatched, repo))
    }

    fn find_agents_for_binding(
        &self,
        kind: BindingKind,
        canonical_key: &str,
    ) -> StoreResult<Vec<FuliAgent>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT a.id, a.name, a.name_key, a.description, a.reply_lang, a.persona_note, a.archived, a.created_at, a.updated_at
             FROM agent_bindings b
             JOIN agents a ON a.id = b.agent_id
             WHERE b.kind = ?1 AND b.canonical_key = ?2 AND b.role = 'own' AND a.archived = 0
             ORDER BY a.created_at ASC",
        )?;
        let rows = stmt.query_map(params![kind.as_str(), canonical_key], row_to_agent)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // =========================================================================
    // Knowledge Bases, Mounts & Authorized Directed Links (<= 2 Hops)
    // =========================================================================

    pub fn create_kb(
        &self,
        name: &str,
        description: &str,
        default_lang: &str,
        read_only: bool,
    ) -> StoreResult<KnowledgeBase> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(StoreError::InvalidInput("kb name cannot be empty".into()));
        }
        let name_key = normalize_name_key(trimmed);
        if let Some(existing) = self.find_kb_by_name_key(&name_key)? {
            return Ok(existing);
        }
        let id = new_id();
        let now = now_rfc3339();
        let lang = if default_lang.trim().is_empty() {
            "zh-CN"
        } else {
            default_lang.trim()
        };
        self.conn.execute(
            "INSERT INTO knowledge_bases (id, name, name_key, description, default_lang, read_only, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, trimmed, name_key, description, lang, i64::from(read_only), now],
        )?;
        self.get_kb(&id)?
            .ok_or_else(|| StoreError::NotFound(format!("kb {id}")))
    }

    pub fn get_kb(&self, id: &str) -> StoreResult<Option<KnowledgeBase>> {
        self.conn
            .query_row(
                "SELECT id, name, name_key, description, default_lang, read_only, created_at, updated_at
                 FROM knowledge_bases WHERE id = ?1",
                [id],
                row_to_kb,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn find_kb_by_name_key(&self, name_key: &str) -> StoreResult<Option<KnowledgeBase>> {
        self.conn
            .query_row(
                "SELECT id, name, name_key, description, default_lang, read_only, created_at, updated_at
                 FROM knowledge_bases WHERE name_key = ?1",
                [name_key],
                row_to_kb,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_kbs(&self) -> StoreResult<Vec<KnowledgeBase>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, name_key, description, default_lang, read_only, created_at, updated_at
             FROM knowledge_bases ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], row_to_kb)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn mount_kb_to_agent(
        &self,
        agent_id: &str,
        kb_id: &str,
        role: MountRole,
    ) -> StoreResult<()> {
        let now = now_rfc3339();
        self.conn.execute(
            "INSERT INTO agent_kb_mounts (agent_id, kb_id, mount_role, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(agent_id, kb_id) DO UPDATE SET mount_role = excluded.mount_role",
            params![agent_id, kb_id, role.as_str(), now],
        )?;
        Ok(())
    }

    pub fn list_agent_mounts(&self, agent_id: &str) -> StoreResult<Vec<AgentKbMount>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.agent_id, m.kb_id, k.name, m.mount_role
             FROM agent_kb_mounts m
             JOIN knowledge_bases k ON k.id = m.kb_id
             WHERE m.agent_id = ?1
             ORDER BY CASE m.mount_role WHEN 'primary' THEN 0 ELSE 1 END, k.name ASC",
        )?;
        let rows = stmt.query_map([agent_id], |row| {
            Ok(AgentKbMount {
                agent_id: row.get(0)?,
                kb_id: row.get(1)?,
                kb_name: row.get(2)?,
                mount_role: MountRole::parse(&row.get::<_, String>(3)?)
                    .unwrap_or(MountRole::Primary),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn primary_kb_for_agent(&self, agent_id: &str) -> StoreResult<Option<KnowledgeBase>> {
        self.conn
            .query_row(
                "SELECT k.id, k.name, k.name_key, k.description, k.default_lang, k.read_only, k.created_at, k.updated_at
                 FROM agent_kb_mounts m
                 JOIN knowledge_bases k ON k.id = m.kb_id
                 WHERE m.agent_id = ?1 AND m.mount_role = 'primary'
                 LIMIT 1",
                [agent_id],
                row_to_kb,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn upsert_kb_link(
        &self,
        from_kb_id: &str,
        to_kb_id: &str,
        relation_type: KbLinkType,
        authority: LinkAuthority,
        weight: f64,
        rationale: &str,
    ) -> StoreResult<KbLink> {
        if from_kb_id == to_kb_id {
            return Err(StoreError::InvalidInput(
                "cannot link a KB to itself".into(),
            ));
        }
        let id = new_id();
        let now = now_rfc3339();
        let confirmed_at = if authority == LinkAuthority::HumanConfirmed {
            Some(now.clone())
        } else {
            None
        };
        self.conn.execute(
            "INSERT INTO kb_links (id, from_kb_id, to_kb_id, relation_type, authority, weight, rationale, confirmed_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(from_kb_id, to_kb_id, relation_type) DO UPDATE SET
               authority = excluded.authority,
               weight = excluded.weight,
               rationale = excluded.rationale,
               confirmed_at = COALESCE(excluded.confirmed_at, kb_links.confirmed_at),
               updated_at = excluded.updated_at",
            params![
                id,
                from_kb_id,
                to_kb_id,
                relation_type.as_str(),
                authority.as_str(),
                weight,
                rationale,
                confirmed_at,
                now
            ],
        )?;
        self.conn
            .query_row(
                "SELECT id, from_kb_id, to_kb_id, relation_type, authority, weight, rationale, confirmed_at, created_at, updated_at
                 FROM kb_links WHERE from_kb_id = ?1 AND to_kb_id = ?2 AND relation_type = ?3",
                params![from_kb_id, to_kb_id, relation_type.as_str()],
                row_to_kb_link,
            )
            .map_err(Into::into)
    }

    pub fn list_kb_links(&self) -> StoreResult<Vec<KbLink>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, from_kb_id, to_kb_id, relation_type, authority, weight, rationale, confirmed_at, created_at, updated_at
             FROM kb_links ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_kb_link)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Compute the exact set of authorized KBs for a given FULI Agent using SQLite
    /// `WITH RECURSIVE` over `kb_links` (`authority = 'human_confirmed'`, <= 2 hops, cycle-safe).
    /// This single query replaces Neo4j's `PERSONAL_PROJECT_RELATION*1..2` traversal!
    pub fn authorized_kbs_for_agent(&self, agent_id: &str) -> StoreResult<Vec<AuthorizedKb>> {
        let mut stmt = self.conn.prepare(
            "WITH RECURSIVE auth_kb(kb_id, hop, weight, path) AS (
                 SELECT m.kb_id, 0, 1.0, ',' || m.kb_id || ','
                 FROM agent_kb_mounts m
                 WHERE m.agent_id = ?1
                 UNION ALL
                 SELECT l.to_kb_id, a.hop + 1, a.weight * l.weight, a.path || l.to_kb_id || ','
                 FROM auth_kb a
                 JOIN kb_links l
                   ON l.from_kb_id = a.kb_id
                  AND l.authority = 'human_confirmed'
                 WHERE a.hop < 2
                   AND instr(a.path, ',' || l.to_kb_id || ',') = 0
             )
             SELECT a.kb_id, k.name, MIN(a.hop) AS best_hop, MAX(a.weight) AS best_weight
             FROM auth_kb a
             JOIN knowledge_bases k ON k.id = a.kb_id
             GROUP BY a.kb_id, k.name
             ORDER BY best_hop ASC, best_weight DESC, k.name ASC",
        )?;
        let rows = stmt.query_map([agent_id], |row| {
            Ok(AuthorizedKb {
                kb_id: row.get(0)?,
                kb_name: row.get(1)?,
                hop: row.get::<_, i64>(2)? as u8,
                weight: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // =========================================================================
    // KB Items, Immutable Version Snapshots, FTS5 Index & Embeddings
    // =========================================================================

    pub fn upsert_kb_item(&self, input: UpsertKbItemInput) -> StoreResult<KbItem> {
        let now = now_rfc3339();
        let aliases_json = serde_json::to_string(&input.aliases)?;
        let evidence_json = serde_json::to_string(&input.evidence)?;

        let existing = if let Some(ref id) = input.id {
            self.get_kb_item(id)?
        } else if let Some(ref sk) = input.stable_key {
            self.find_kb_item_by_stable_key(&input.kb_id, sk)?
        } else {
            None
        };

        let item_id = if let Some(prev) = existing {
            let next_rev = prev.revision + 1;
            self.conn.execute(
                "UPDATE kb_items SET
                    stable_key = ?2,
                    item_type = ?3,
                    status = ?4,
                    lang = ?5,
                    translation_of_id = ?6,
                    title = ?7,
                    body = ?8,
                    context_summary = ?9,
                    aliases_json = ?10,
                    evidence_json = ?11,
                    revision = ?12,
                    needs_review = 0,
                    updated_at = ?13
                 WHERE id = ?1",
                params![
                    prev.id,
                    input.stable_key,
                    input.item_type.as_str(),
                    input.status.as_str(),
                    input.lang,
                    input.translation_of_id,
                    input.title,
                    input.body,
                    input.context_summary,
                    aliases_json,
                    evidence_json,
                    next_rev,
                    now
                ],
            )?;
            self.insert_item_version(
                &prev.id,
                next_rev,
                input.status,
                &input.title,
                &input.body,
                &input.context_summary,
                &aliases_json,
                &input.change_reason,
                &input.changed_by,
                &now,
            )?;
            prev.id
        } else {
            let id = input.id.unwrap_or_else(new_id);
            self.conn.execute(
                "INSERT INTO kb_items (
                    id, kb_id, stable_key, item_type, status, lang, translation_of_id,
                    title, body, context_summary, aliases_json, evidence_json,
                    revision, valid_from, valid_to, superseded_by_id,
                    reuse_count, helpful_count, needs_review, last_reused_at, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                    ?8, ?9, ?10, ?11, ?12,
                    1, ?13, NULL, NULL,
                    0, 0, 0, NULL, ?13, ?13
                 )",
                params![
                    id,
                    input.kb_id,
                    input.stable_key,
                    input.item_type.as_str(),
                    input.status.as_str(),
                    input.lang,
                    input.translation_of_id,
                    input.title,
                    input.body,
                    input.context_summary,
                    aliases_json,
                    evidence_json,
                    now
                ],
            )?;
            self.insert_item_version(
                &id,
                1,
                input.status,
                &input.title,
                &input.body,
                &input.context_summary,
                &aliases_json,
                &input.change_reason,
                &input.changed_by,
                &now,
            )?;
            id
        };

        let item = self
            .get_kb_item(&item_id)?
            .ok_or_else(|| StoreError::NotFound(format!("kb_item {item_id}")))?;
        self.sync_item_fts(&item)?;
        Ok(item)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_item_version(
        &self,
        item_id: &str,
        revision: i64,
        status: KbItemStatus,
        title: &str,
        body: &str,
        context_summary: &str,
        aliases_json: &str,
        change_reason: &str,
        changed_by: &str,
        created_at: &str,
    ) -> StoreResult<()> {
        let ver_id = new_id();
        self.conn.execute(
            "INSERT INTO kb_item_versions (
                id, item_id, revision, status, title, body, context_summary, aliases_json,
                change_reason, changed_by, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                ver_id,
                item_id,
                revision,
                status.as_str(),
                title,
                body,
                context_summary,
                aliases_json,
                change_reason,
                changed_by,
                created_at
            ],
        )?;
        Ok(())
    }

    pub fn sync_item_fts(&self, item: &KbItem) -> StoreResult<()> {
        self.conn
            .execute("DELETE FROM kb_items_fts WHERE item_id = ?1", [&item.id])?;
        if item.status == KbItemStatus::Deprecated {
            return Ok(());
        }
        let title_tok = tokenize_for_index(&item.title);
        let alias_tok = tokenize_for_index(&item.aliases.join(" "));
        let ctx_tok = tokenize_for_index(&item.context_summary);
        let body_tok = tokenize_for_index(&item.body);
        self.conn.execute(
            "INSERT INTO kb_items_fts (item_id, kb_id, title_tokens, alias_tokens, context_tokens, body_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![item.id, item.kb_id, title_tok, alias_tok, ctx_tok, body_tok],
        )?;
        Ok(())
    }

    pub fn set_kb_item_status(
        &self,
        item_id: &str,
        new_status: KbItemStatus,
        change_reason: &str,
        changed_by: &str,
    ) -> StoreResult<KbItem> {
        let prev = self
            .get_kb_item(item_id)?
            .ok_or_else(|| StoreError::NotFound(format!("kb_item {item_id}")))?;
        let next_rev = prev.revision + 1;
        let now = now_rfc3339();
        let valid_to = if new_status == KbItemStatus::Deprecated {
            Some(now.clone())
        } else {
            None
        };
        let needs_review = if new_status == KbItemStatus::Confirmed {
            0
        } else {
            i64::from(prev.needs_review)
        };
        self.conn.execute(
            "UPDATE kb_items SET status = ?2, revision = ?3, valid_to = ?4, needs_review = ?5, updated_at = ?6
             WHERE id = ?1",
            params![item_id, new_status.as_str(), next_rev, valid_to, needs_review, now],
        )?;
        let aliases_json = serde_json::to_string(&prev.aliases)?;
        self.insert_item_version(
            item_id,
            next_rev,
            new_status,
            &prev.title,
            &prev.body,
            &prev.context_summary,
            &aliases_json,
            change_reason,
            changed_by,
            &now,
        )?;
        let updated = self
            .get_kb_item(item_id)?
            .ok_or_else(|| StoreError::NotFound(format!("kb_item {item_id}")))?;
        self.sync_item_fts(&updated)?;
        Ok(updated)
    }

    pub fn get_kb_item(&self, id: &str) -> StoreResult<Option<KbItem>> {
        self.conn
            .query_row(
                "SELECT id, kb_id, stable_key, item_type, status, lang, translation_of_id,
                        title, body, context_summary, aliases_json, evidence_json,
                        revision, valid_from, valid_to, superseded_by_id,
                        reuse_count, helpful_count, needs_review, last_reused_at, created_at, updated_at
                 FROM kb_items WHERE id = ?1",
                [id],
                row_to_kb_item,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn find_kb_item_by_stable_key(
        &self,
        kb_id: &str,
        stable_key: &str,
    ) -> StoreResult<Option<KbItem>> {
        self.conn
            .query_row(
                "SELECT id, kb_id, stable_key, item_type, status, lang, translation_of_id,
                        title, body, context_summary, aliases_json, evidence_json,
                        revision, valid_from, valid_to, superseded_by_id,
                        reuse_count, helpful_count, needs_review, last_reused_at, created_at, updated_at
                 FROM kb_items WHERE kb_id = ?1 AND stable_key = ?2 LIMIT 1",
                params![kb_id, stable_key],
                row_to_kb_item,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_kb_items(
        &self,
        kb_id: Option<&str>,
        status: Option<KbItemStatus>,
    ) -> StoreResult<Vec<KbItem>> {
        let mut sql = String::from(
            "SELECT id, kb_id, stable_key, item_type, status, lang, translation_of_id,
                    title, body, context_summary, aliases_json, evidence_json,
                    revision, valid_from, valid_to, superseded_by_id,
                    reuse_count, helpful_count, needs_review, last_reused_at, created_at, updated_at
             FROM kb_items WHERE 1=1",
        );
        let mut bind_vals: Vec<String> = Vec::new();
        if let Some(kb) = kb_id {
            sql.push_str(" AND kb_id = ?");
            bind_vals.push(kb.to_string());
        }
        if let Some(st) = status {
            sql.push_str(" AND status = ?");
            bind_vals.push(st.as_str().to_string());
        }
        sql.push_str(" ORDER BY updated_at DESC");

        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = bind_vals
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let rows = stmt.query_map(params_refs.as_slice(), row_to_kb_item)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_kb_item_versions(&self, item_id: &str) -> StoreResult<Vec<KbItemVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, item_id, revision, status, title, body, context_summary, aliases_json, change_reason, changed_by, created_at
             FROM kb_item_versions WHERE item_id = ?1 ORDER BY revision DESC",
        )?;
        let rows = stmt.query_map([item_id], |row| {
            let aliases_raw: String = row.get(7)?;
            let aliases: Vec<String> = serde_json::from_str(&aliases_raw).unwrap_or_default();
            Ok(KbItemVersion {
                id: row.get(0)?,
                item_id: row.get(1)?,
                revision: row.get(2)?,
                status: KbItemStatus::parse(&row.get::<_, String>(3)?)
                    .unwrap_or(KbItemStatus::Confirmed),
                title: row.get(4)?,
                body: row.get(5)?,
                context_summary: row.get(6)?,
                aliases,
                change_reason: row.get(8)?,
                changed_by: row.get(9)?,
                created_at: row.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn upsert_kb_edge(
        &self,
        from_item_id: &str,
        to_item_id: &str,
        edge_type: KbEdgeType,
        authority: LinkAuthority,
        weight: f64,
        note: &str,
    ) -> StoreResult<KbEdge> {
        let id = new_id();
        let now = now_rfc3339();
        self.conn.execute(
            "INSERT INTO kb_edges (id, from_item_id, to_item_id, edge_type, authority, weight, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(from_item_id, to_item_id, edge_type) DO UPDATE SET
               authority = excluded.authority, weight = excluded.weight, note = excluded.note",
            params![id, from_item_id, to_item_id, edge_type.as_str(), authority.as_str(), weight, note, now],
        )?;
        self.conn
            .query_row(
                "SELECT id, from_item_id, to_item_id, edge_type, authority, weight, note, created_at
                 FROM kb_edges WHERE from_item_id = ?1 AND to_item_id = ?2 AND edge_type = ?3",
                params![from_item_id, to_item_id, edge_type.as_str()],
                |row| {
                    Ok(KbEdge {
                        id: row.get(0)?,
                        from_item_id: row.get(1)?,
                        to_item_id: row.get(2)?,
                        edge_type: KbEdgeType::parse(&row.get::<_, String>(3)?)
                            .unwrap_or(KbEdgeType::RelatedTo),
                        authority: LinkAuthority::parse(&row.get::<_, String>(4)?)
                            .unwrap_or(LinkAuthority::Suggested),
                        weight: row.get(5)?,
                        note: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn list_edges_for_item(&self, item_id: &str) -> StoreResult<Vec<KbEdge>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, from_item_id, to_item_id, edge_type, authority, weight, note, created_at
             FROM kb_edges WHERE from_item_id = ?1 OR to_item_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([item_id], |row| {
            Ok(KbEdge {
                id: row.get(0)?,
                from_item_id: row.get(1)?,
                to_item_id: row.get(2)?,
                edge_type: KbEdgeType::parse(&row.get::<_, String>(3)?)
                    .unwrap_or(KbEdgeType::RelatedTo),
                authority: LinkAuthority::parse(&row.get::<_, String>(4)?)
                    .unwrap_or(LinkAuthority::Suggested),
                weight: row.get(5)?,
                note: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn upsert_embedding(
        &self,
        item_id: &str,
        model_id: &str,
        vector: &[f32],
    ) -> StoreResult<()> {
        let now = now_rfc3339();
        let mut blob = Vec::with_capacity(vector.len() * 4);
        for &v in vector {
            blob.extend_from_slice(&v.to_le_bytes());
        }
        self.conn.execute(
            "INSERT INTO kb_embeddings (item_id, model_id, dims, vector_blob, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(item_id) DO UPDATE SET
               model_id = excluded.model_id, dims = excluded.dims, vector_blob = excluded.vector_blob, updated_at = excluded.updated_at",
            params![item_id, model_id, vector.len() as i64, blob, now],
        )?;
        Ok(())
    }

    pub fn load_embeddings_for_kbs(&self, kb_ids: &[String]) -> StoreResult<Vec<EmbeddingRow>> {
        if kb_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; kb_ids.len()].join(",");
        let sql = format!(
            "SELECT e.item_id, e.model_id, e.vector_blob
             FROM kb_embeddings e
             JOIN kb_items i ON i.id = e.item_id
             WHERE i.kb_id IN ({placeholders}) AND i.status != 'deprecated'"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            kb_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            let blob: Vec<u8> = row.get(2)?;
            let vector = blob
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| f32::from_le_bytes(*c))
                .collect();
            Ok(EmbeddingRow {
                item_id: row.get(0)?,
                model_id: row.get(1)?,
                vector,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // =========================================================================
    // Two-Track Personal vs Project Rules & Preferences
    // =========================================================================

    pub fn upsert_rule_or_pref(&self, input: UpsertRuleInput) -> StoreResult<RuleOrPref> {
        let now = now_rfc3339();
        let applicability_json = serde_json::to_string(&input.applicability)?;

        let id = if let Some(ref existing_id) = input.id {
            let prev_rev: Option<i64> = self
                .conn
                .query_row(
                    "SELECT revision FROM rules_and_prefs WHERE id = ?1",
                    [existing_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(rev) = prev_rev {
                self.conn.execute(
                    "UPDATE rules_and_prefs SET
                        scope_kind = ?2, scope_id = ?3, constraint_class = ?4, aspect = ?5,
                        pref_key = ?6, authority = ?7, status = ?8, content = ?9,
                        rationale = ?10, applicability_json = ?11, revision = ?12, updated_at = ?13
                     WHERE id = ?1",
                    params![
                        existing_id,
                        input.scope_kind.as_str(),
                        input.scope_id,
                        input.constraint_class.as_str(),
                        input.aspect.as_str(),
                        input.pref_key,
                        input.authority.as_str(),
                        input.status.as_str(),
                        input.content,
                        input.rationale,
                        applicability_json,
                        rev + 1,
                        now
                    ],
                )?;
                existing_id.clone()
            } else {
                self.insert_new_rule(existing_id, &input, &applicability_json, &now)?;
                existing_id.clone()
            }
        } else {
            let new_rule_id = new_id();
            self.insert_new_rule(&new_rule_id, &input, &applicability_json, &now)?;
            new_rule_id
        };

        self.get_rule(&id)?
            .ok_or_else(|| StoreError::NotFound(format!("rule {id}")))
    }

    fn insert_new_rule(
        &self,
        id: &str,
        input: &UpsertRuleInput,
        applicability_json: &str,
        now: &str,
    ) -> StoreResult<()> {
        self.conn.execute(
            "INSERT INTO rules_and_prefs (
                id, scope_kind, scope_id, constraint_class, aspect, pref_key,
                authority, status, content, rationale, applicability_json, revision, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?12)",
            params![
                id,
                input.scope_kind.as_str(),
                input.scope_id,
                input.constraint_class.as_str(),
                input.aspect.as_str(),
                input.pref_key,
                input.authority.as_str(),
                input.status.as_str(),
                input.content,
                input.rationale,
                applicability_json,
                now
            ],
        )?;
        Ok(())
    }

    pub fn get_rule(&self, id: &str) -> StoreResult<Option<RuleOrPref>> {
        self.conn
            .query_row(
                "SELECT id, scope_kind, scope_id, constraint_class, aspect, pref_key,
                        authority, status, content, rationale, applicability_json, revision, created_at, updated_at
                 FROM rules_and_prefs WHERE id = ?1",
                [id],
                row_to_rule,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_rules_for_context(&self, agent_id: Option<&str>) -> StoreResult<Vec<RuleOrPref>> {
        let mut stmt = if agent_id.is_some() {
            self.conn.prepare(
                "SELECT id, scope_kind, scope_id, constraint_class, aspect, pref_key,
                        authority, status, content, rationale, applicability_json, revision, created_at, updated_at
                 FROM rules_and_prefs
                 WHERE scope_kind = 'personal_global'
                    OR (scope_kind = 'agent' AND scope_id = ?1)
                 ORDER BY updated_at DESC",
            )?
        } else {
            self.conn.prepare(
                "SELECT id, scope_kind, scope_id, constraint_class, aspect, pref_key,
                        authority, status, content, rationale, applicability_json, revision, created_at, updated_at
                 FROM rules_and_prefs ORDER BY updated_at DESC",
            )?
        };

        let rows = if let Some(aid) = agent_id {
            stmt.query_map([aid], row_to_rule)?
        } else {
            stmt.query_map([], row_to_rule)?
        };
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn resolve_effective_rules(
        &self,
        agent_id: Option<&str>,
        work_kind: Option<&str>,
    ) -> StoreResult<ResolvedRules> {
        let raw = self.list_rules_for_context(agent_id)?;
        Ok(resolve_rules_and_prefs(&raw, work_kind))
    }

    pub fn approve_rule(&self, rule_id: &str, promote_to_hard: bool) -> StoreResult<RuleOrPref> {
        let prev = self
            .get_rule(rule_id)?
            .ok_or_else(|| StoreError::NotFound(format!("rule {rule_id}")))?;
        let now = now_rfc3339();
        let next_class = if promote_to_hard {
            ConstraintClass::HardRule
        } else {
            prev.constraint_class
        };
        let next_aspect = if promote_to_hard {
            PreferenceAspect::HardRule
        } else {
            prev.aspect
        };
        self.conn.execute(
            "UPDATE rules_and_prefs
             SET status = 'active', authority = 'human_confirmed',
                 constraint_class = ?2, aspect = ?3, revision = revision + 1, updated_at = ?4
             WHERE id = ?1",
            params![rule_id, next_class.as_str(), next_aspect.as_str(), now],
        )?;
        self.get_rule(rule_id)?
            .ok_or_else(|| StoreError::NotFound(format!("rule {rule_id}")))
    }

    pub fn disable_rule(&self, rule_id: &str) -> StoreResult<RuleOrPref> {
        let now = now_rfc3339();
        self.conn.execute(
            "UPDATE rules_and_prefs SET status = 'disabled', revision = revision + 1, updated_at = ?2 WHERE id = ?1",
            params![rule_id, now],
        )?;
        self.get_rule(rule_id)?
            .ok_or_else(|| StoreError::NotFound(format!("rule {rule_id}")))
    }

    /// Resolve a rule conflict in 1 click: keep `winner_id` active, disable all `loser_ids`.
    pub fn resolve_rule_conflict(&self, winner_id: &str, loser_ids: &[String]) -> StoreResult<()> {
        self.approve_rule(winner_id, false)?;
        for lid in loser_ids {
            if lid != winner_id {
                let _ = self.disable_rule(lid)?;
            }
        }
        Ok(())
    }

    // =========================================================================
    // Workstreams, Checkpoints, Compounding Events & Feedback
    // =========================================================================

    pub fn checkpoint_workstream(
        &self,
        input: CheckpointInput,
    ) -> StoreResult<(Workstream, WorkstreamCheckpoint)> {
        let now = now_rfc3339();
        let ws_id = if let Some(ref existing_id) = input.workstream_id {
            if self.get_workstream(existing_id)?.is_some() {
                existing_id.clone()
            } else {
                self.create_workstream_row(
                    Some(existing_id.clone()),
                    &input.agent_id,
                    input.title.as_deref().unwrap_or(&input.goal),
                    input.status.unwrap_or(WorkstreamStatus::Active),
                    input.worktree_path.as_deref().unwrap_or(""),
                    input.branch_name.as_deref().unwrap_or(""),
                    &now,
                )?
            }
        } else {
            self.create_workstream_row(
                None,
                &input.agent_id,
                input.title.as_deref().unwrap_or(&input.goal),
                input.status.unwrap_or(WorkstreamStatus::Active),
                input.worktree_path.as_deref().unwrap_or(""),
                input.branch_name.as_deref().unwrap_or(""),
                &now,
            )?
        };

        let next_seq: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM workstream_checkpoints WHERE workstream_id = ?1",
            [&ws_id],
            |r| r.get(0),
        )?;

        let cp_id = new_id();
        let decisions_json = serde_json::to_string(&input.decisions)?;
        let next_steps_json = serde_json::to_string(&input.next_steps)?;
        let reused_refs_json = serde_json::to_string(&input.reused_refs)?;

        self.conn.execute(
            "INSERT INTO workstream_checkpoints (
                id, workstream_id, seq, goal, current_state, decisions_json, next_steps_json,
                reused_refs_json, source_client, source_session_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                cp_id,
                ws_id,
                next_seq,
                input.goal,
                input.current_state,
                decisions_json,
                next_steps_json,
                reused_refs_json,
                input.source_client,
                input.source_session_id,
                now
            ],
        )?;

        let status = input.status.unwrap_or(WorkstreamStatus::Active);
        self.conn.execute(
            "UPDATE workstreams
             SET head_checkpoint_id = ?2,
                 status = ?3,
                 worktree_path = CASE WHEN ?4 != '' THEN ?4 ELSE worktree_path END,
                 branch_name = CASE WHEN ?5 != '' THEN ?5 ELSE branch_name END,
                 updated_at = ?6
             WHERE id = ?1",
            params![
                ws_id,
                cp_id,
                status.as_str(),
                input.worktree_path.as_deref().unwrap_or(""),
                input.branch_name.as_deref().unwrap_or(""),
                now
            ],
        )?;

        // Auto-record real compounding events for every explicitly reused knowledge/rule ref!
        for rref in &input.reused_refs {
            self.record_compounding_event(
                &input.agent_id,
                Some(&ws_id),
                &rref.kind,
                &rref.id,
                rref.rev,
                &input.source_client,
                &rref.note,
            )?;
        }

        let ws = self
            .get_workstream(&ws_id)?
            .ok_or_else(|| StoreError::NotFound(format!("workstream {ws_id}")))?;
        let cp = self
            .get_checkpoint(&cp_id)?
            .ok_or_else(|| StoreError::NotFound(format!("checkpoint {cp_id}")))?;
        Ok((ws, cp))
    }

    #[allow(clippy::too_many_arguments)]
    fn create_workstream_row(
        &self,
        explicit_id: Option<String>,
        agent_id: &str,
        title: &str,
        status: WorkstreamStatus,
        worktree_path: &str,
        branch_name: &str,
        now: &str,
    ) -> StoreResult<String> {
        let id = explicit_id.unwrap_or_else(new_id);
        let short_title: String = title.trim().chars().take(120).collect();
        self.conn.execute(
            "INSERT INTO workstreams (id, agent_id, title, status, head_checkpoint_id, worktree_path, branch_name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?7)",
            params![id, agent_id, short_title, status.as_str(), worktree_path, branch_name, now],
        )?;
        Ok(id)
    }

    pub fn get_workstream(&self, id: &str) -> StoreResult<Option<Workstream>> {
        self.conn
            .query_row(
                "SELECT id, agent_id, title, status, head_checkpoint_id, worktree_path, branch_name, created_at, updated_at
                 FROM workstreams WHERE id = ?1",
                [id],
                row_to_workstream,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_workstreams(
        &self,
        agent_id: Option<&str>,
        only_open: bool,
    ) -> StoreResult<Vec<Workstream>> {
        let mut sql = String::from(
            "SELECT id, agent_id, title, status, head_checkpoint_id, worktree_path, branch_name, created_at, updated_at
             FROM workstreams WHERE 1=1",
        );
        let mut bind: Vec<String> = Vec::new();
        if let Some(aid) = agent_id {
            sql.push_str(" AND agent_id = ?");
            bind.push(aid.to_string());
        }
        if only_open {
            sql.push_str(" AND status IN ('active', 'paused')");
        }
        sql.push_str(" ORDER BY updated_at DESC");
        let mut stmt = self.conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> =
            bind.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), row_to_workstream)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_checkpoint(&self, id: &str) -> StoreResult<Option<WorkstreamCheckpoint>> {
        self.conn
            .query_row(
                "SELECT id, workstream_id, seq, goal, current_state, decisions_json, next_steps_json,
                        reused_refs_json, source_client, source_session_id, created_at
                 FROM workstream_checkpoints WHERE id = ?1",
                [id],
                row_to_checkpoint,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn latest_checkpoint_for_workstream(
        &self,
        workstream_id: &str,
    ) -> StoreResult<Option<WorkstreamCheckpoint>> {
        self.conn
            .query_row(
                "SELECT id, workstream_id, seq, goal, current_state, decisions_json, next_steps_json,
                        reused_refs_json, source_client, source_session_id, created_at
                 FROM workstream_checkpoints
                 WHERE workstream_id = ?1
                 ORDER BY seq DESC LIMIT 1",
                [workstream_id],
                row_to_checkpoint,
            )
            .optional()
            .map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_compounding_event(
        &self,
        agent_id: &str,
        workstream_id: Option<&str>,
        target_kind: &str,
        target_id: &str,
        target_revision: i64,
        client_id: &str,
        note: &str,
    ) -> StoreResult<CompoundingEvent> {
        let id = new_id();
        let now = now_rfc3339();
        self.conn.execute(
            "INSERT INTO compounding_events (
                id, agent_id, workstream_id, target_kind, target_id, target_revision,
                client_id, note, human_feedback, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)",
            params![
                id,
                agent_id,
                workstream_id,
                target_kind,
                target_id,
                target_revision,
                client_id,
                note,
                now
            ],
        )?;
        if target_kind == "kb_item" {
            self.conn.execute(
                "UPDATE kb_items SET reuse_count = reuse_count + 1, last_reused_at = ?2 WHERE id = ?1",
                params![target_id, now],
            )?;
        }
        Ok(CompoundingEvent {
            id,
            agent_id: agent_id.to_string(),
            workstream_id: workstream_id.map(ToOwned::to_owned),
            target_kind: target_kind.to_string(),
            target_id: target_id.to_string(),
            target_revision,
            client_id: client_id.to_string(),
            note: note.to_string(),
            human_feedback: None,
            created_at: now,
        })
    }

    /// Apply human feedback (`helpful` / `stale` / `wrong`) directly to a KB item or compounding event.
    pub fn apply_kb_feedback(&self, item_id: &str, feedback: HumanFeedback) -> StoreResult<KbItem> {
        let now = now_rfc3339();
        match feedback {
            HumanFeedback::Helpful => {
                self.conn.execute(
                    "UPDATE kb_items SET helpful_count = helpful_count + 1, needs_review = 0, updated_at = ?2 WHERE id = ?1",
                    params![item_id, now],
                )?;
            }
            HumanFeedback::Stale | HumanFeedback::Wrong => {
                self.conn.execute(
                    "UPDATE kb_items SET needs_review = 1, updated_at = ?2 WHERE id = ?1",
                    params![item_id, now],
                )?;
            }
        }
        self.get_kb_item(item_id)?
            .ok_or_else(|| StoreError::NotFound(format!("kb_item {item_id}")))
    }

    pub fn list_recent_compounding_events(
        &self,
        limit: usize,
    ) -> StoreResult<Vec<CompoundingEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, agent_id, workstream_id, target_kind, target_id, target_revision,
                    client_id, note, human_feedback, created_at
             FROM compounding_events ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            let fb_raw: Option<String> = row.get(8)?;
            Ok(CompoundingEvent {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                workstream_id: row.get(2)?,
                target_kind: row.get(3)?,
                target_id: row.get(4)?,
                target_revision: row.get(5)?,
                client_id: row.get(6)?,
                note: row.get(7)?,
                human_feedback: fb_raw.as_deref().and_then(HumanFeedback::parse),
                created_at: row.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // =========================================================================
    // Workflows (FLA Reusable Procedures)
    // =========================================================================

    pub fn upsert_workflow(
        &self,
        id: Option<&str>,
        agent_id: &str,
        title: &str,
        summary: &str,
        steps: &[String],
        status: WorkflowStatus,
    ) -> StoreResult<Workflow> {
        let now = now_rfc3339();
        let steps_json = serde_json::to_string(steps)?;
        let wf_id = if let Some(existing_id) = id {
            let updated = self.conn.execute(
                "UPDATE workflows SET title = ?2, summary = ?3, steps_json = ?4, status = ?5, revision = revision + 1, updated_at = ?6 WHERE id = ?1",
                params![existing_id, title, summary, steps_json, status.as_str(), now],
            )?;
            if updated == 0 {
                self.conn.execute(
                    "INSERT INTO workflows (id, agent_id, title, summary, steps_json, status, run_count, pass_count, revision, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 1, ?7, ?7)",
                    params![existing_id, agent_id, title, summary, steps_json, status.as_str(), now],
                )?;
            }
            existing_id.to_string()
        } else {
            let new_wf_id = new_id();
            self.conn.execute(
                "INSERT INTO workflows (id, agent_id, title, summary, steps_json, status, run_count, pass_count, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 1, ?7, ?7)",
                params![new_wf_id, agent_id, title, summary, steps_json, status.as_str(), now],
            )?;
            new_wf_id
        };
        self.get_workflow(&wf_id)?
            .ok_or_else(|| StoreError::NotFound(format!("workflow {wf_id}")))
    }

    pub fn record_workflow_run(&self, workflow_id: &str, passed: bool) -> StoreResult<Workflow> {
        let now = now_rfc3339();
        self.conn.execute(
            "UPDATE workflows SET run_count = run_count + 1, pass_count = pass_count + ?2, updated_at = ?3 WHERE id = ?1",
            params![workflow_id, i64::from(passed), now],
        )?;
        self.get_workflow(workflow_id)?
            .ok_or_else(|| StoreError::NotFound(format!("workflow {workflow_id}")))
    }

    pub fn get_workflow(&self, id: &str) -> StoreResult<Option<Workflow>> {
        self.conn
            .query_row(
                "SELECT id, agent_id, title, summary, steps_json, status, run_count, pass_count, revision, created_at, updated_at
                 FROM workflows WHERE id = ?1",
                [id],
                row_to_workflow,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_workflows(&self, agent_id: Option<&str>) -> StoreResult<Vec<Workflow>> {
        let mut stmt = if agent_id.is_some() {
            self.conn.prepare(
                "SELECT id, agent_id, title, summary, steps_json, status, run_count, pass_count, revision, created_at, updated_at
                 FROM workflows WHERE agent_id = ?1 ORDER BY updated_at DESC",
            )?
        } else {
            self.conn.prepare(
                "SELECT id, agent_id, title, summary, steps_json, status, run_count, pass_count, revision, created_at, updated_at
                 FROM workflows ORDER BY updated_at DESC",
            )?
        };
        let rows = if let Some(aid) = agent_id {
            stmt.query_map([aid], row_to_workflow)?
        } else {
            stmt.query_map([], row_to_workflow)?
        };
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // =========================================================================
    // Sessions & Delivery Ledger Helpers
    // =========================================================================

    pub fn upsert_session(
        &self,
        client_id: &str,
        session_id: &str,
        agent_id: Option<&str>,
        active_ws_id: Option<&str>,
        cwd: &str,
        last_summary: Option<&str>,
    ) -> StoreResult<SessionRecord> {
        let now = now_rfc3339();
        let norm_cwd = normalize_dir_path(cwd);
        let summary = last_summary.unwrap_or("");
        self.conn.execute(
            "INSERT INTO sessions (client_id, session_id, agent_id, active_ws_id, cwd, context_epoch, control_mode, last_summary, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 'normal', ?6, ?7, ?7)
             ON CONFLICT(client_id, session_id) DO UPDATE SET
               agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
               active_ws_id = COALESCE(excluded.active_ws_id, sessions.active_ws_id),
               cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
               last_summary = CASE WHEN excluded.last_summary != '' THEN excluded.last_summary ELSE sessions.last_summary END,
               updated_at = excluded.updated_at",
            params![client_id, session_id, agent_id, active_ws_id, norm_cwd, summary, now],
        )?;
        self.get_session(client_id, session_id)?
            .ok_or_else(|| StoreError::NotFound(format!("session {client_id}:{session_id}")))
    }

    pub fn get_session(
        &self,
        client_id: &str,
        session_id: &str,
    ) -> StoreResult<Option<SessionRecord>> {
        self.conn
            .query_row(
                "SELECT client_id, session_id, agent_id, active_ws_id, cwd, context_epoch, control_mode, last_summary, created_at, updated_at
                 FROM sessions WHERE client_id = ?1 AND session_id = ?2",
                params![client_id, session_id],
                row_to_session,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_sessions(&self, limit: usize) -> StoreResult<Vec<SessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT client_id, session_id, agent_id, active_ws_id, cwd, context_epoch, control_mode, last_summary, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], row_to_session)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_session_control_mode(
        &self,
        client_id: &str,
        session_id: &str,
        mode: SessionControlMode,
    ) -> StoreResult<SessionRecord> {
        let now = now_rfc3339();
        self.upsert_session(client_id, session_id, None, None, "", None)?;
        self.conn.execute(
            "UPDATE sessions SET control_mode = ?3, updated_at = ?4 WHERE client_id = ?1 AND session_id = ?2",
            params![client_id, session_id, mode.as_str(), now],
        )?;
        self.get_session(client_id, session_id)?
            .ok_or_else(|| StoreError::NotFound(format!("session {client_id}:{session_id}")))
    }

    pub fn bump_session_epoch(&self, client_id: &str, session_id: &str) -> StoreResult<i64> {
        let now = now_rfc3339();
        self.upsert_session(client_id, session_id, None, None, "", None)?;
        self.conn.execute(
            "UPDATE sessions SET context_epoch = context_epoch + 1, updated_at = ?3 WHERE client_id = ?1 AND session_id = ?2",
            params![client_id, session_id, now],
        )?;
        let epoch: i64 = self.conn.query_row(
            "SELECT context_epoch FROM sessions WHERE client_id = ?1 AND session_id = ?2",
            params![client_id, session_id],
            |r| r.get(0),
        )?;
        Ok(epoch)
    }

    pub fn insert_delivery_record(&self, rec: &DeliveryRecord) -> StoreResult<()> {
        self.conn.execute(
            "INSERT INTO delivery_ledger (
                id, client_id, session_id, context_epoch, turn_seq, trigger_kind,
                target_kind, target_id, target_revision, delivery_mode, tokens_est, reason, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                rec.id,
                rec.client_id,
                rec.session_id,
                rec.context_epoch,
                rec.turn_seq,
                rec.trigger_kind,
                rec.target_kind,
                rec.target_id,
                rec.target_revision,
                rec.delivery_mode.as_str(),
                rec.tokens_est,
                rec.reason,
                rec.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_recent_deliveries(&self, limit: usize) -> StoreResult<Vec<DeliveryRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, client_id, session_id, context_epoch, turn_seq, trigger_kind,
                    target_kind, target_id, target_revision, delivery_mode, tokens_est, reason, created_at
             FROM delivery_ledger ORDER BY created_at DESC, turn_seq DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            Ok(DeliveryRecord {
                id: row.get(0)?,
                client_id: row.get(1)?,
                session_id: row.get(2)?,
                context_epoch: row.get(3)?,
                turn_seq: row.get(4)?,
                trigger_kind: row.get(5)?,
                target_kind: row.get(6)?,
                target_id: row.get(7)?,
                target_revision: row.get(8)?,
                delivery_mode: DeliveryMode::parse(&row.get::<_, String>(9)?)
                    .unwrap_or(DeliveryMode::Full),
                tokens_est: row.get(10)?,
                reason: row.get(11)?,
                created_at: row.get(12)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // =========================================================================
    // Roundtable Exchanges Storage (used by pluggable `fuli-roundtable`)
    // =========================================================================

    #[allow(clippy::too_many_arguments)]
    pub fn insert_roundtable_exchange(
        &self,
        agent_id: Option<&str>,
        from_client: &str,
        from_session_id: &str,
        to_client: &str,
        to_session_id: &str,
        question: &str,
        answer: Option<&str>,
        wake_status: WakeStatus,
    ) -> StoreResult<RoundtableExchange> {
        let id = new_id();
        let now = now_rfc3339();
        let answered_at = answer.map(|_| now.clone());
        self.conn.execute(
            "INSERT INTO roundtable_exchanges (
                id, agent_id, from_client, from_session_id, to_client, to_session_id,
                question, answer, wake_status, created_at, answered_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                agent_id,
                from_client,
                from_session_id,
                to_client,
                to_session_id,
                question,
                answer,
                wake_status.as_str(),
                now,
                answered_at
            ],
        )?;
        Ok(RoundtableExchange {
            id,
            agent_id: agent_id.map(ToOwned::to_owned),
            from_client: from_client.to_string(),
            from_session_id: from_session_id.to_string(),
            to_client: to_client.to_string(),
            to_session_id: to_session_id.to_string(),
            question: question.to_string(),
            answer: answer.map(ToOwned::to_owned),
            wake_status,
            created_at: now,
            answered_at,
        })
    }

    pub fn answer_roundtable_exchange(
        &self,
        exchange_id: &str,
        answer: &str,
        wake_status: WakeStatus,
    ) -> StoreResult<()> {
        let now = now_rfc3339();
        self.conn.execute(
            "UPDATE roundtable_exchanges SET answer = ?2, wake_status = ?3, answered_at = ?4 WHERE id = ?1",
            params![exchange_id, answer, wake_status.as_str(), now],
        )?;
        Ok(())
    }

    pub fn list_roundtable_exchanges(
        &self,
        to_client: Option<&str>,
        to_session_id: Option<&str>,
        only_pending: bool,
        limit: usize,
    ) -> StoreResult<Vec<RoundtableExchange>> {
        let mut sql = String::from(
            "SELECT id, agent_id, from_client, from_session_id, to_client, to_session_id,
                    question, answer, wake_status, created_at, answered_at
             FROM roundtable_exchanges WHERE 1=1",
        );
        let mut bind: Vec<String> = Vec::new();
        if let Some(c) = to_client {
            sql.push_str(" AND to_client = ?");
            bind.push(c.to_string());
        }
        if let Some(s) = to_session_id {
            sql.push_str(" AND to_session_id = ?");
            bind.push(s.to_string());
        }
        if only_pending {
            sql.push_str(" AND wake_status = 'queued_inbox'");
        }
        sql.push_str(" ORDER BY created_at DESC LIMIT ");
        sql.push_str(&limit.to_string());

        let mut stmt = self.conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> =
            bind.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok(RoundtableExchange {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                from_client: row.get(2)?,
                from_session_id: row.get(3)?,
                to_client: row.get(4)?,
                to_session_id: row.get(5)?,
                question: row.get(6)?,
                answer: row.get(7)?,
                wake_status: WakeStatus::parse(&row.get::<_, String>(8)?)
                    .unwrap_or(WakeStatus::QueuedInbox),
                created_at: row.get(9)?,
                answered_at: row.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// List unread (`queued_inbox`) Roundtable exchanges deliverable to a live turn:
    /// matches exact `(to_client, to_session_id)`, client-wide wildcard (`to_session_id IN ('*', '', 'default')`),
    /// OR bot-scoped wildcard (`agent_id = matched_agent_id` AND `to_client = '*'`), while excluding
    /// questions sent by the exact same `(client_id, session_id)` so a session never receives its own prompt.
    pub fn list_pending_roundtable_for_turn(
        &self,
        client_id: &str,
        session_id: &str,
        agent_id: Option<&str>,
        limit: usize,
    ) -> StoreResult<Vec<RoundtableExchange>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, agent_id, from_client, from_session_id, to_client, to_session_id,
                    question, answer, wake_status, created_at, answered_at
             FROM roundtable_exchanges
             WHERE wake_status = 'queued_inbox'
               AND NOT (from_client = ?1 AND from_session_id = ?2)
               AND (
                    (to_client = ?1 AND (to_session_id = ?2 OR to_session_id IN ('*', '', 'default')))
                    OR (?3 IS NOT NULL AND agent_id = ?3 AND (to_client = '*' OR to_client = '' OR to_client = ?1)
                        AND to_session_id IN ('*', '', 'default'))
               )
             ORDER BY created_at ASC
             LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![client_id, session_id, agent_id, limit as i64],
            |row| {
                Ok(RoundtableExchange {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    from_client: row.get(2)?,
                    from_session_id: row.get(3)?,
                    to_client: row.get(4)?,
                    to_session_id: row.get(5)?,
                    question: row.get(6)?,
                    answer: row.get(7)?,
                    wake_status: WakeStatus::parse(&row.get::<_, String>(8)?)
                        .unwrap_or(WakeStatus::QueuedInbox),
                    created_at: row.get(9)?,
                    answered_at: row.get(10)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // =========================================================================
    // Pending Human Decisions & Global Portfolio Summary (Jefa Value)
    // =========================================================================

    pub fn list_pending_items(&self) -> StoreResult<PendingItemsSnapshot> {
        let proposed_items = self.list_kb_items(None, Some(KbItemStatus::Proposal))?;

        let mut stmt = self.conn.prepare(
            "SELECT id, scope_kind, scope_id, constraint_class, aspect, pref_key,
                    authority, status, content, rationale, applicability_json, revision, created_at, updated_at
             FROM rules_and_prefs WHERE status = 'pending' ORDER BY updated_at DESC",
        )?;
        let pending_rules = stmt
            .query_map([], row_to_rule)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut wf_stmt = self.conn.prepare(
            "SELECT id, agent_id, title, summary, steps_json, status, run_count, pass_count, revision, created_at, updated_at
             FROM workflows WHERE status = 'proposed' ORDER BY updated_at DESC",
        )?;
        let proposed_workflows = wf_stmt
            .query_map([], row_to_workflow)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut stale_stmt = self.conn.prepare(
            "SELECT id, kb_id, stable_key, item_type, status, lang, translation_of_id,
                    title, body, context_summary, aliases_json, evidence_json,
                    revision, valid_from, valid_to, superseded_by_id,
                    reuse_count, helpful_count, needs_review, last_reused_at, created_at, updated_at
             FROM kb_items WHERE status = 'confirmed' AND needs_review = 1 ORDER BY updated_at DESC",
        )?;
        let stale_items = stale_stmt
            .query_map([], row_to_kb_item)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PendingItemsSnapshot {
            proposed_items,
            pending_rules,
            proposed_workflows,
            stale_items,
        })
    }

    /// Global cross-project summary powering Today's compounding statement and daily/weekly reports.
    pub fn query_portfolio_summary(&self, since_days: u32) -> StoreResult<PortfolioSummary> {
        let days = since_days.clamp(1, 365);
        let cutoff = (Utc::now() - Duration::days(i64::from(days)))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

        let total_agents: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM agents WHERE archived = 0", [], |r| {
                    r.get(0)
                })?;
        let active_workstreams: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM workstreams WHERE status IN ('active', 'paused')",
            [],
            |r| r.get(0),
        )?;
        let completed_workstreams: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM workstreams WHERE status = 'done' AND updated_at >= ?1",
            [&cutoff],
            |r| r.get(0),
        )?;
        let compounding_events_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM compounding_events WHERE created_at >= ?1",
            [&cutoff],
            |r| r.get(0),
        )?;
        let new_confirmed_knowledge: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM kb_items WHERE status = 'confirmed' AND updated_at >= ?1",
            [&cutoff],
            |r| r.get(0),
        )?;
        let pending_kb: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM kb_items WHERE status = 'proposal'",
            [],
            |r| r.get(0),
        )?;
        let pending_rules: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM rules_and_prefs WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )?;
        let pending_wf: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM workflows WHERE status = 'proposed'",
            [],
            |r| r.get(0),
        )?;

        let mut stmt = self.conn.prepare(
            "SELECT a.name, w.title, w.status, c.current_state, c.next_steps_json, c.source_client, c.created_at
             FROM workstream_checkpoints c
             JOIN workstreams w ON w.id = c.workstream_id
             JOIN agents a ON a.id = w.agent_id
             WHERE c.created_at >= ?1
             ORDER BY c.created_at DESC
             LIMIT 25",
        )?;
        let recent_checkpoints = stmt
            .query_map([&cutoff], |row| {
                let next_raw: String = row.get(4)?;
                let next_steps: Vec<String> = serde_json::from_str(&next_raw).unwrap_or_default();
                Ok(PortfolioCheckpointBrief {
                    agent_name: row.get(0)?,
                    workstream_title: row.get(1)?,
                    status: WorkstreamStatus::parse(&row.get::<_, String>(2)?)
                        .unwrap_or(WorkstreamStatus::Active),
                    current_state: row.get(3)?,
                    next_steps,
                    source_client: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // 7-week compounding sparkline buckets (oldest -> current week)
        let now_utc = Utc::now() + Duration::seconds(2);
        let mut weekly_compounding_series = Vec::with_capacity(7);
        for weeks_ago in (0..7).rev() {
            let start = (now_utc - Duration::days((weeks_ago + 1) * 7))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let end = (now_utc - Duration::days(weeks_ago * 7))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM compounding_events WHERE created_at >= ?1 AND created_at <= ?2",
                params![start, end],
                |r| r.get(0),
            )?;
            weekly_compounding_series.push(count);
        }

        Ok(PortfolioSummary {
            since_days: days,
            total_agents: total_agents as usize,
            active_workstreams: active_workstreams as usize,
            completed_workstreams: completed_workstreams as usize,
            compounding_events_count: compounding_events_count as usize,
            new_confirmed_knowledge: new_confirmed_knowledge as usize,
            pending_proposals_count: (pending_kb + pending_rules + pending_wf) as usize,
            recent_checkpoints,
            weekly_compounding_series,
        })
    }

    /// Count distinct tokens saved across recent delivery dedup skips.
    pub fn total_tokens_saved_by_dedup(&self) -> StoreResult<i64> {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(tokens_est), 0) FROM delivery_ledger WHERE delivery_mode = 'skipped_dedup'",
                [],
                |r| r.get(0),
            )
            .map_err(Into::into)
    }

    /// Return all unique active rule conflicts across PersonalGlobal + every active FULI Agent.
    pub fn list_all_rule_conflicts(&self) -> StoreResult<Vec<fuli_domain::RuleConflict>> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let global = self.resolve_effective_rules(None, None)?;
        for c in global.conflicts {
            let sig = format!(
                "{}:{}",
                c.pref_key,
                c.candidates
                    .iter()
                    .map(|r| r.id.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            );
            if seen.insert(sig) {
                out.push(c);
            }
        }
        for agent in self.list_agents(false)? {
            let res = self.resolve_effective_rules(Some(&agent.id), None)?;
            for c in res.conflicts {
                let sig = format!(
                    "{}:{}",
                    c.pref_key,
                    c.candidates
                        .iter()
                        .map(|r| r.id.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                if seen.insert(sig) {
                    out.push(c);
                }
            }
        }
        Ok(out)
    }
}

fn is_same_or_child_dir(cwd: &str, parent: &str) -> bool {
    if cwd == parent {
        return true;
    }
    let prefix = if parent.ends_with('/') {
        parent.to_string()
    } else {
        format!("{parent}/")
    };
    cwd.starts_with(&prefix)
}

fn row_to_agent(row: &rusqlite::Row<'_>) -> rusqlite::Result<FuliAgent> {
    Ok(FuliAgent {
        id: row.get(0)?,
        name: row.get(1)?,
        name_key: row.get(2)?,
        description: row.get(3)?,
        reply_lang: row.get(4)?,
        persona_note: row.get(5)?,
        archived: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn row_to_binding(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentBinding> {
    Ok(AgentBinding {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        kind: BindingKind::parse(&row.get::<_, String>(2)?).unwrap_or(BindingKind::DirPath),
        canonical_key: row.get(3)?,
        role: BindingRole::parse(&row.get::<_, String>(4)?).unwrap_or(BindingRole::Own),
        label: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn row_to_kb(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeBase> {
    Ok(KnowledgeBase {
        id: row.get(0)?,
        name: row.get(1)?,
        name_key: row.get(2)?,
        description: row.get(3)?,
        default_lang: row.get(4)?,
        read_only: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn row_to_kb_link(row: &rusqlite::Row<'_>) -> rusqlite::Result<KbLink> {
    Ok(KbLink {
        id: row.get(0)?,
        from_kb_id: row.get(1)?,
        to_kb_id: row.get(2)?,
        relation_type: KbLinkType::parse(&row.get::<_, String>(3)?).unwrap_or(KbLinkType::Cites),
        authority: LinkAuthority::parse(&row.get::<_, String>(4)?)
            .unwrap_or(LinkAuthority::Suggested),
        weight: row.get(5)?,
        rationale: row.get(6)?,
        confirmed_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn row_to_kb_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<KbItem> {
    let aliases_raw: String = row.get(10)?;
    let evidence_raw: String = row.get(11)?;
    Ok(KbItem {
        id: row.get(0)?,
        kb_id: row.get(1)?,
        stable_key: row.get(2)?,
        item_type: KbItemType::parse(&row.get::<_, String>(3)?).unwrap_or(KbItemType::Fact),
        status: KbItemStatus::parse(&row.get::<_, String>(4)?).unwrap_or(KbItemStatus::Confirmed),
        lang: row.get(5)?,
        translation_of_id: row.get(6)?,
        title: row.get(7)?,
        body: row.get(8)?,
        context_summary: row.get(9)?,
        aliases: serde_json::from_str(&aliases_raw).unwrap_or_default(),
        evidence: serde_json::from_str(&evidence_raw).unwrap_or_else(|_| serde_json::json!({})),
        revision: row.get(12)?,
        valid_from: row.get(13)?,
        valid_to: row.get(14)?,
        superseded_by_id: row.get(15)?,
        reuse_count: row.get(16)?,
        helpful_count: row.get(17)?,
        needs_review: row.get::<_, i64>(18)? != 0,
        last_reused_at: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

fn row_to_rule(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuleOrPref> {
    let app_raw: String = row.get(10)?;
    Ok(RuleOrPref {
        id: row.get(0)?,
        scope_kind: RuleScope::parse(&row.get::<_, String>(1)?).unwrap_or(RuleScope::Agent),
        scope_id: row.get(2)?,
        constraint_class: ConstraintClass::parse(&row.get::<_, String>(3)?)
            .unwrap_or(ConstraintClass::Preference),
        aspect: PreferenceAspect::parse(&row.get::<_, String>(4)?)
            .unwrap_or(PreferenceAspect::Taste),
        pref_key: row.get(5)?,
        authority: RuleAuthority::parse(&row.get::<_, String>(6)?)
            .unwrap_or(RuleAuthority::AiProposal),
        status: RuleStatus::parse(&row.get::<_, String>(7)?).unwrap_or(RuleStatus::Pending),
        content: row.get(8)?,
        rationale: row.get(9)?,
        applicability: serde_json::from_str(&app_raw).unwrap_or_default(),
        revision: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn row_to_workstream(row: &rusqlite::Row<'_>) -> rusqlite::Result<Workstream> {
    Ok(Workstream {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        title: row.get(2)?,
        status: WorkstreamStatus::parse(&row.get::<_, String>(3)?)
            .unwrap_or(WorkstreamStatus::Active),
        head_checkpoint_id: row.get(4)?,
        worktree_path: row.get(5)?,
        branch_name: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn row_to_checkpoint(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkstreamCheckpoint> {
    let dec_raw: String = row.get(5)?;
    let next_raw: String = row.get(6)?;
    let refs_raw: String = row.get(7)?;
    Ok(WorkstreamCheckpoint {
        id: row.get(0)?,
        workstream_id: row.get(1)?,
        seq: row.get(2)?,
        goal: row.get(3)?,
        current_state: row.get(4)?,
        decisions: serde_json::from_str(&dec_raw).unwrap_or_default(),
        next_steps: serde_json::from_str(&next_raw).unwrap_or_default(),
        reused_refs: serde_json::from_str(&refs_raw).unwrap_or_default(),
        source_client: row.get(8)?,
        source_session_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn row_to_workflow(row: &rusqlite::Row<'_>) -> rusqlite::Result<Workflow> {
    let steps_raw: String = row.get(4)?;
    Ok(Workflow {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        steps: serde_json::from_str(&steps_raw).unwrap_or_default(),
        status: WorkflowStatus::parse(&row.get::<_, String>(5)?)
            .unwrap_or(WorkflowStatus::Proposed),
        run_count: row.get(6)?,
        pass_count: row.get(7)?,
        revision: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        client_id: row.get(0)?,
        session_id: row.get(1)?,
        agent_id: row.get(2)?,
        active_ws_id: row.get(3)?,
        cwd: row.get(4)?,
        context_epoch: row.get(5)?,
        control_mode: SessionControlMode::parse(&row.get::<_, String>(6)?)
            .unwrap_or(SessionControlMode::Normal),
        last_summary: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// Resolve symlinks so one folder reached two ways compares equal (macOS `/tmp` is
/// `/private/tmp`; hosts report the resolved form). Falls back to the input when the
/// folder doesn't exist, e.g. a binding for a folder that isn't checked out yet.
fn real_dir_path(raw: &str) -> String {
    std::fs::canonicalize(raw.trim())
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .map(|p| p.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(p))
        .unwrap_or_else(|| raw.to_string())
}
