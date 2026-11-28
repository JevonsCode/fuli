use serde::{Deserialize, Serialize};

/// Official entity: `FULI Agent` (short: `FLA`).
/// Anchors a project's repos/directories, mounted knowledge bases,
/// Workbench workstreams, Workflows, and project-scoped rules/preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FuliAgent {
    pub id: String,
    pub name: String,
    pub name_key: String,
    pub description: String,
    pub reply_lang: String,
    pub persona_note: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingKind {
    GitRemote,
    DirPath,
}

impl BindingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitRemote => "git_remote",
            Self::DirPath => "dir_path",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "git_remote" => Some(Self::GitRemote),
            "dir_path" => Some(Self::DirPath),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingRole {
    Own,
    Reference,
}

impl BindingRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Own => "own",
            Self::Reference => "reference",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "own" => Some(Self::Own),
            "reference" => Some(Self::Reference),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentBinding {
    pub id: String,
    pub agent_id: String,
    pub kind: BindingKind,
    pub canonical_key: String,
    pub role: BindingRole,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AgentResolution {
    Matched {
        basis: String,
        agent: FuliAgent,
    },
    Ambiguous {
        reason: String,
        candidates: Vec<FuliAgent>,
    },
    Unmatched,
}

// ============================================================================
// Knowledge Base, Directed Authorized Links, Versioned Items & Graph Edges
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub name_key: String,
    pub description: String,
    pub default_lang: String,
    pub read_only: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MountRole {
    Primary,
    AttachedReadonly,
}

impl MountRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::AttachedReadonly => "attached_readonly",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "primary" => Some(Self::Primary),
            "attached_readonly" => Some(Self::AttachedReadonly),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentKbMount {
    pub agent_id: String,
    pub kb_id: String,
    pub kb_name: String,
    pub mount_role: MountRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KbLinkType {
    Cites,
    Inherits,
}

impl KbLinkType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cites => "cites",
            Self::Inherits => "inherits",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "cites" => Some(Self::Cites),
            "inherits" => Some(Self::Inherits),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkAuthority {
    Suggested,
    HumanConfirmed,
    Revoked,
}

impl LinkAuthority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Suggested => "suggested",
            Self::HumanConfirmed => "human_confirmed",
            Self::Revoked => "revoked",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "suggested" => Some(Self::Suggested),
            "human_confirmed" => Some(Self::HumanConfirmed),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KbLink {
    pub id: String,
    pub from_kb_id: String,
    pub to_kb_id: String,
    pub relation_type: KbLinkType,
    pub authority: LinkAuthority,
    pub weight: f64,
    pub rationale: String,
    pub confirmed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One authorized KB reachable from an agent within <= 2 confirmed hops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthorizedKb {
    pub kb_id: String,
    pub kb_name: String,
    pub hop: u8,
    pub weight: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KbItemType {
    Fact,
    Runbook,
    Experience,
    Decision,
}

impl KbItemType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Runbook => "runbook",
            Self::Experience => "experience",
            Self::Decision => "decision",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "fact" => Some(Self::Fact),
            "runbook" => Some(Self::Runbook),
            "experience" => Some(Self::Experience),
            "decision" => Some(Self::Decision),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KbItemStatus {
    Proposal,
    Confirmed,
    Deprecated,
}

impl KbItemStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proposal => "proposal",
            Self::Confirmed => "confirmed",
            Self::Deprecated => "deprecated",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "proposal" => Some(Self::Proposal),
            "confirmed" => Some(Self::Confirmed),
            "deprecated" => Some(Self::Deprecated),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KbItem {
    pub id: String,
    pub kb_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stable_key: Option<String>,
    pub item_type: KbItemType,
    pub status: KbItemStatus,
    pub lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_of_id: Option<String>,
    pub title: String,
    pub body: String,
    pub context_summary: String,
    pub aliases: Vec<String>,
    pub evidence: serde_json::Value,
    pub revision: i64,
    pub valid_from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by_id: Option<String>,
    pub reuse_count: i64,
    pub helpful_count: i64,
    pub needs_review: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_reused_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KbItemVersion {
    pub id: String,
    pub item_id: String,
    pub revision: i64,
    pub status: KbItemStatus,
    pub title: String,
    pub body: String,
    pub context_summary: String,
    pub aliases: Vec<String>,
    pub change_reason: String,
    pub changed_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KbEdgeType {
    DependsOn,
    Contradicts,
    Extends,
    RelatedTo,
}

impl KbEdgeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DependsOn => "depends_on",
            Self::Contradicts => "contradicts",
            Self::Extends => "extends",
            Self::RelatedTo => "related_to",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "depends_on" => Some(Self::DependsOn),
            "contradicts" => Some(Self::Contradicts),
            "extends" => Some(Self::Extends),
            "related_to" => Some(Self::RelatedTo),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KbEdge {
    pub id: String,
    pub from_item_id: String,
    pub to_item_id: String,
    pub edge_type: KbEdgeType,
    pub authority: LinkAuthority,
    pub weight: f64,
    pub note: String,
    pub created_at: String,
}

// ============================================================================
// Two-Track Personal vs Project Rules & Preferences
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleScope {
    PersonalGlobal,
    Agent,
}

impl RuleScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PersonalGlobal => "personal_global",
            Self::Agent => "agent",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "personal_global" => Some(Self::PersonalGlobal),
            "agent" | "unit" | "project" => Some(Self::Agent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintClass {
    HardRule,
    Preference,
}

impl ConstraintClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HardRule => "hard_rule",
            Self::Preference => "preference",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "hard_rule" => Some(Self::HardRule),
            "preference" => Some(Self::Preference),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreferenceAspect {
    HardRule,
    Taste,
    Personality,
    Judgment,
}

impl PreferenceAspect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HardRule => "hard_rule",
            Self::Taste => "taste",
            Self::Personality => "personality",
            Self::Judgment => "judgment",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "hard_rule" => Some(Self::HardRule),
            "taste" => Some(Self::Taste),
            "personality" => Some(Self::Personality),
            "judgment" | "judgment_preference" => Some(Self::Judgment),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleAuthority {
    HumanExplicit,
    HumanConfirmed,
    AiProposal,
}

impl RuleAuthority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HumanExplicit => "human_explicit",
            Self::HumanConfirmed => "human_confirmed",
            Self::AiProposal => "ai_proposal",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "human_explicit" => Some(Self::HumanExplicit),
            "human_confirmed" => Some(Self::HumanConfirmed),
            "ai_proposal" => Some(Self::AiProposal),
            _ => None,
        }
    }

    pub fn is_human_authorized(self) -> bool {
        matches!(self, Self::HumanExplicit | Self::HumanConfirmed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleStatus {
    Active,
    Pending,
    Disabled,
}

impl RuleStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Pending => "pending",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "active" => Some(Self::Active),
            "pending" => Some(Self::Pending),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleApplicability {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_kinds: Vec<String>,
}

impl RuleApplicability {
    pub fn matches(&self, work_kind: Option<&str>) -> bool {
        if self.work_kinds.is_empty() {
            return true;
        }
        let Some(wk) = work_kind.map(str::trim).filter(|s| !s.is_empty()) else {
            // Structured scoped rules stay out when task work_kind is unspecified,
            // preventing PRD-only rules from leaking into unrelated coding turns.
            return false;
        };
        self.work_kinds.iter().any(|k| k.eq_ignore_ascii_case(wk))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleOrPref {
    pub id: String,
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
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

// ============================================================================
// Workstreams, Checkpoints, Workflows & Sessions
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkstreamStatus {
    Active,
    Paused,
    Done,
}

impl WorkstreamStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Done => "done",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "active" => Some(Self::Active),
            "paused" => Some(Self::Paused),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workstream {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub status: WorkstreamStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_checkpoint_id: Option<String>,
    pub worktree_path: String,
    pub branch_name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionRecord {
    pub decision: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReusedRef {
    pub kind: String,
    pub id: String,
    pub rev: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkstreamCheckpoint {
    pub id: String,
    pub workstream_id: String,
    pub seq: i64,
    pub goal: String,
    pub current_state: String,
    pub decisions: Vec<DecisionRecord>,
    pub next_steps: Vec<String>,
    pub reused_refs: Vec<ReusedRef>,
    pub source_client: String,
    pub source_session_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    Proposed,
    Active,
    Disabled,
}

impl WorkflowStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Active => "active",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "proposed" => Some(Self::Proposed),
            "active" => Some(Self::Active),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub summary: String,
    pub steps: Vec<String>,
    pub status: WorkflowStatus,
    pub run_count: i64,
    pub pass_count: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionControlMode {
    Normal,
    CapturePaused,
    Disabled,
}

impl SessionControlMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::CapturePaused => "capture_paused",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "normal" => Some(Self::Normal),
            "capture_paused" => Some(Self::CapturePaused),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRecord {
    pub client_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_ws_id: Option<String>,
    pub cwd: String,
    pub context_epoch: i64,
    pub control_mode: SessionControlMode,
    pub last_summary: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    Full,
    TitleOnly,
    DeltaRemoved,
    SkippedDedup,
    TruncatedBudget,
}

impl DeliveryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::TitleOnly => "title_only",
            Self::DeltaRemoved => "delta_removed",
            Self::SkippedDedup => "skipped_dedup",
            Self::TruncatedBudget => "truncated_budget",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "full" => Some(Self::Full),
            "title_only" => Some(Self::TitleOnly),
            "delta_removed" => Some(Self::DeltaRemoved),
            "skipped_dedup" => Some(Self::SkippedDedup),
            "truncated_budget" => Some(Self::TruncatedBudget),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryRecord {
    pub id: String,
    pub client_id: String,
    pub session_id: String,
    pub context_epoch: i64,
    pub turn_seq: i64,
    pub trigger_kind: String,
    pub target_kind: String,
    pub target_id: String,
    pub target_revision: i64,
    pub delivery_mode: DeliveryMode,
    pub tokens_est: i64,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HumanFeedback {
    Helpful,
    Stale,
    Wrong,
}

impl HumanFeedback {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Helpful => "helpful",
            Self::Stale => "stale",
            Self::Wrong => "wrong",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "helpful" => Some(Self::Helpful),
            "stale" => Some(Self::Stale),
            "wrong" => Some(Self::Wrong),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompoundingEvent {
    pub id: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workstream_id: Option<String>,
    pub target_kind: String,
    pub target_id: String,
    pub target_revision: i64,
    pub client_id: String,
    pub note: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_feedback: Option<HumanFeedback>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeStatus {
    WokenReplied,
    QueuedInbox,
    Failed,
}

impl WakeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WokenReplied => "woken_replied",
            Self::QueuedInbox => "queued_inbox",
            Self::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "woken_replied" => Some(Self::WokenReplied),
            "queued_inbox" => Some(Self::QueuedInbox),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoundtableExchange {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub from_client: String,
    pub from_session_id: String,
    pub to_client: String,
    pub to_session_id: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    pub wake_status: WakeStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<String>,
    /// Why a live wake produced no answer (empty when it answered or was only queued).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fail_reason: String,
}

/// Autonomy policy for preference-guided judgment (lightweight Tonborg value).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyLevel {
    /// Human confirms everything (default).
    Manual,
    /// Show recommendation + reason based on judgment preferences; 1-click accept.
    Assist,
    /// Auto-confirm low-risk routine facts (1-click undoable); hard rules & conflicts always ask human.
    AutoRoutine,
}

/// Global cross-project summary powering daily/weekly reports (lightweight Jefa value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortfolioSummary {
    pub since_days: u32,
    pub total_agents: usize,
    pub active_workstreams: usize,
    pub completed_workstreams: usize,
    pub compounding_events_count: usize,
    pub new_confirmed_knowledge: usize,
    pub pending_proposals_count: usize,
    pub recent_checkpoints: Vec<PortfolioCheckpointBrief>,
    pub weekly_compounding_series: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortfolioCheckpointBrief {
    pub agent_name: String,
    pub workstream_title: String,
    pub status: WorkstreamStatus,
    pub current_state: String,
    pub next_steps: Vec<String>,
    pub source_client: String,
    pub created_at: String,
}
