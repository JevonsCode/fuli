use std::time::Instant;

use fuli_domain::{
    AgentBinding, AgentKbMount, AuthorizedKb, AutonomyLevel, DeliveryRecord, FuliAgent, KbItem,
    KbItemType, KbItemVersion, KbLink, KnowledgeBase, PortfolioSummary, RoundtableExchange,
    RuleConflict, RuleOrPref, SessionRecord, Workflow, Workstream,
};
use fuli_ipc::{IpcRequest, IpcResponse, MemorySnapshot, send_request};
use serde::Deserialize;
use serde_json::Value;

use crate::memory;

#[derive(Debug, Clone, Deserialize)]
pub struct AgentCardData {
    pub agent: FuliAgent,
    #[serde(default)]
    pub bindings: Vec<AgentBinding>,
    #[serde(default)]
    pub mounts: Vec<AgentKbMount>,
    #[serde(default)]
    pub authorized_kbs: Vec<AuthorizedKb>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PendingSnapshot {
    #[serde(default)]
    pub proposed_items: Vec<KbItem>,
    #[serde(default)]
    pub pending_rules: Vec<RuleOrPref>,
    #[serde(default)]
    pub proposed_workflows: Vec<Workflow>,
    #[serde(default)]
    pub stale_items: Vec<KbItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DreamingSuggestionData {
    pub headline: String,
    pub detail: String,
    pub action_hint: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DreamingReportData {
    #[serde(default)]
    pub scanned_items: usize,
    #[serde(default)]
    pub duplicate_pairs_found: usize,
    #[serde(default)]
    pub stale_items_found: usize,
    #[serde(default)]
    pub promotion_candidates_found: usize,
    #[serde(default)]
    pub suggestions: Vec<DreamingSuggestionData>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchHitData {
    pub id: String,
    pub kb_name: String,
    pub hop: u8,
    pub item_type: KbItemType,
    pub title: String,
    pub body: String,
    pub rev: i64,
    pub score: f64,
    #[serde(default)]
    pub needs_review: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BudgetInfoData {
    pub limit_bytes: usize,
    pub used_bytes: usize,
    pub complete: bool,
    pub returned: usize,
    pub total_matched: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchResultData {
    pub query: String,
    #[serde(default)]
    pub hits: Vec<SearchHitData>,
    pub budget: BudgetInfoData,
    pub authorized_kb_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ItemDetailData {
    pub item: KbItem,
    #[serde(default)]
    pub versions: Vec<KbItemVersion>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ClientStatusData {
    pub client: String,
    pub display_name: String,
    pub config_path: String,
    pub config_dir_exists: bool,
    pub fuli_configured: bool,
    pub supports_hooks: bool,
    #[serde(default)]
    pub cli_available: bool,
    #[serde(default)]
    pub cli_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct VectorCacheStatsData {
    #[serde(default)]
    pub loaded: bool,
    #[serde(default)]
    pub vector_count: usize,
    #[serde(default)]
    pub approx_bytes: usize,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct BotSessionDigestData {
    pub client_id: String,
    pub session_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub last_seen_at: String,
    #[serde(default)]
    pub supports_native_resume: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct BotSessionLedgerData {
    pub agent_id: String,
    pub agent_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub latest_session: Option<BotSessionDigestData>,
    #[serde(default)]
    pub recent_sessions: Vec<BotSessionDigestData>,
    #[serde(default)]
    pub active_workstream_title: Option<String>,
    #[serde(default)]
    pub active_workstream_state: Option<String>,
    #[serde(default)]
    pub open_workstream_count: usize,
    #[serde(default)]
    pub active_rule_count: usize,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct BotRouteCandidateData {
    pub agent_id: String,
    pub agent_name: String,
    #[serde(default)]
    pub score: u32,
    #[serde(default)]
    pub latest_client: Option<String>,
    #[serde(default)]
    pub latest_session_id: Option<String>,
    #[serde(default)]
    pub reason: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ConciergeRoutePreviewData {
    pub prompt: String,
    #[serde(default)]
    pub is_global_overview: bool,
    #[serde(default)]
    pub selected_agent_id: Option<String>,
    pub selected_agent_name: String,
    #[serde(default)]
    pub auto_detected: bool,
    #[serde(default)]
    pub confidence: u8,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub candidate_bots: Vec<BotRouteCandidateData>,
    pub target_client: String,
    pub target_session_id: String,
    #[serde(default)]
    pub target_session_summary: String,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub client_cli_available: bool,
    #[serde(default)]
    pub allow_write: bool,
    #[serde(default)]
    pub switched_from_client: Option<String>,
    #[serde(default)]
    pub available_clients: Vec<String>,
    pub mode: String,
    #[serde(default)]
    pub can_answer_from_memory: bool,
    #[serde(default)]
    pub handoff_brief_preview: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ConciergeTaskData {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub target_client: String,
    pub target_session_id: String,
    #[serde(default)]
    pub switched_from_client: Option<String>,
    pub mode: String,
    pub status: String,
    #[serde(default)]
    pub step_label: String,
    #[serde(default)]
    pub result_preview: Option<String>,
    #[serde(default)]
    pub exchange_id: Option<String>,
    #[serde(default)]
    pub was_corrected: bool,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DashboardData {
    pub portfolio: PortfolioSummary,
    #[serde(default)]
    pub agents: Vec<AgentCardData>,
    #[serde(default)]
    pub knowledge_bases: Vec<KnowledgeBase>,
    #[serde(default)]
    pub kb_links: Vec<KbLink>,
    #[serde(default)]
    pub kb_items: Vec<KbItem>,
    #[serde(default)]
    pub rules: Vec<RuleOrPref>,
    #[serde(default)]
    pub rule_conflicts: Vec<RuleConflict>,
    #[serde(default)]
    pub pending: PendingSnapshot,
    #[serde(default)]
    pub workstreams: Vec<Workstream>,
    #[serde(default)]
    pub workflows: Vec<Workflow>,
    #[serde(default)]
    pub sessions: Vec<SessionRecord>,
    #[serde(default)]
    pub deliveries: Vec<DeliveryRecord>,
    #[serde(default)]
    pub tokens_saved: i64,
    #[serde(default)]
    pub roundtable: Vec<RoundtableExchange>,
    #[serde(default)]
    pub bot_session_ledgers: Vec<BotSessionLedgerData>,
    #[serde(default)]
    pub concierge_tasks: Vec<ConciergeTaskData>,
    #[serde(default)]
    pub dreaming: DreamingReportData,
    #[serde(default = "default_autonomy")]
    pub autonomy_level: AutonomyLevel,
    #[serde(default = "default_locale")]
    pub ui_locale: String,
    #[serde(default)]
    pub clients: Vec<ClientStatusData>,
    #[serde(default)]
    pub vector_cache: VectorCacheStatsData,
}

fn default_autonomy() -> AutonomyLevel {
    AutonomyLevel::Manual
}

fn default_locale() -> String {
    "zh-CN".to_string()
}

impl Default for DashboardData {
    fn default() -> Self {
        Self {
            portfolio: PortfolioSummary {
                since_days: 7,
                total_agents: 0,
                active_workstreams: 0,
                completed_workstreams: 0,
                compounding_events_count: 0,
                new_confirmed_knowledge: 0,
                pending_proposals_count: 0,
                recent_checkpoints: Vec::new(),
                weekly_compounding_series: vec![0, 0, 0, 0, 0, 0, 0],
            },
            agents: Vec::new(),
            knowledge_bases: Vec::new(),
            kb_links: Vec::new(),
            kb_items: Vec::new(),
            rules: Vec::new(),
            rule_conflicts: Vec::new(),
            pending: PendingSnapshot::default(),
            workstreams: Vec::new(),
            workflows: Vec::new(),
            sessions: Vec::new(),
            deliveries: Vec::new(),
            tokens_saved: 0,
            roundtable: Vec::new(),
            bot_session_ledgers: Vec::new(),
            concierge_tasks: Vec::new(),
            dreaming: DreamingReportData::default(),
            autonomy_level: AutonomyLevel::Manual,
            ui_locale: "zh-CN".to_string(),
            clients: Vec::new(),
            vector_cache: VectorCacheStatsData::default(),
        }
    }
}

pub struct DaemonStatusView {
    pub connected: bool,
    pub daemon_pid: Option<u32>,
    pub daemon_mem: MemorySnapshot,
    pub ui_mem: MemorySnapshot,
    pub ipc_rtt_ms: f64,
    pub uptime_secs: u64,
    pub db_path: String,
    pub note: String,
    pub data: DashboardData,
}

impl DaemonStatusView {
    pub fn fetch(endpoint: &str) -> Self {
        let ui_mem = memory::current_process_memory();
        let t0 = Instant::now();
        match send_request(endpoint, &IpcRequest::Ping) {
            Ok(IpcResponse::Pong {
                pid,
                memory,
                uptime_secs,
                db_path,
                ..
            }) => {
                let rtt_ms = t0.elapsed().as_secs_f64() * 1000.0;
                let data = match send_request(endpoint, &IpcRequest::DashboardSnapshot) {
                    Ok(IpcResponse::Json { data, .. }) => {
                        serde_json::from_value(data).unwrap_or_default()
                    }
                    _ => DashboardData::default(),
                };
                Self {
                    connected: true,
                    daemon_pid: Some(pid),
                    daemon_mem: memory,
                    ui_mem,
                    ipc_rtt_ms: rtt_ms,
                    uptime_secs,
                    db_path,
                    note: "后台服务运行正常".to_string(),
                    data,
                }
            }
            Ok(_) => Self::offline(ui_mem, "收到意外的后台应答".to_string()),
            Err(err) => Self::offline(ui_mem, format!("后台服务尚未启动 ({err})")),
        }
    }

    fn offline(ui_mem: MemorySnapshot, note: String) -> Self {
        Self {
            connected: false,
            daemon_pid: None,
            daemon_mem: MemorySnapshot {
                working_set_bytes: 0,
                private_bytes: 0,
            },
            ui_mem,
            ipc_rtt_ms: 0.0,
            uptime_secs: 0,
            db_path: "—".to_string(),
            note,
            data: DashboardData::default(),
        }
    }
}

pub fn dispatch_ui_action(endpoint: &str, action: &str, payload: Value) -> Result<Value, String> {
    match send_request(
        endpoint,
        &IpcRequest::UiAction {
            action: action.to_string(),
            payload,
        },
    ) {
        Ok(IpcResponse::Json { data, .. }) => Ok(data),
        Ok(IpcResponse::Error { message, .. }) => Err(message),
        Ok(other) => Err(format!("unexpected reply: {other:?}")),
        Err(err) => Err(err.to_string()),
    }
}

/// Format the native CLI resume command for a live client session so the user can
/// copy and run it in 1 click from the unified FULI Agent Workbench.
pub fn session_resume_command(client_id: &str, session_id: &str) -> String {
    match client_id.to_ascii_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => format!("claude --resume {session_id}"),
        "codex" => format!("codex exec resume {session_id}"),
        _ => format!("fuli hook --client {client_id} --session {session_id}"),
    }
}
