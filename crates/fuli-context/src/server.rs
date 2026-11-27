use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use fuli_domain::{new_id, now_rfc3339};
use fuli_dreaming::{DreamingReport, run_layer1_scan};
use fuli_ipc::{
    IpcRequest, IpcResponse, ListenerExt as _, bind_listener, cleanup_endpoint, read_frame,
    send_request, write_frame,
};
use fuli_roundtable::{
    AskAgentPlan, ConciergeDispatchPrep, ConciergeTask, ConciergeTaskStatus, RoundtableTier,
    client_display_name, execute_native_wake, finalize_native_wake, new_concierge_task,
    prepare_concierge_dispatch, preview_concierge_route, record_concierge_route_correction,
};
use fuli_search::{DEFAULT_VECTOR_IDLE_TTL_SECS, IdleUnloadVectorCache};
use fuli_store::FuliStore;

use crate::dispatch::{
    build_dashboard_snapshot, dispatch_tool, handle_hook_event, handle_ui_action,
    parse_concierge_preview_request, prepare_ask_agent_request,
};
use crate::memory::current_process_memory;
use crate::ui_process::UiProcessManager;

const DREAMING_INTERVAL_SECS: u64 = 6 * 3600;

pub struct DaemonState {
    pub endpoint: String,
    pub started_at: Instant,
    pub shutting_down: AtomicBool,
    pub ui: UiProcessManager,
    pub store: Mutex<FuliStore>,
    pub vector_cache: IdleUnloadVectorCache,
    pub last_dreaming: Mutex<Option<(Instant, DreamingReport)>>,
    pub concierge_tasks: Mutex<Vec<ConciergeTask>>,
    pub db_path_display: String,
    on_shutdown: Box<dyn Fn() + Send + Sync>,
}

impl DaemonState {
    pub fn new(
        endpoint: String,
        ui: UiProcessManager,
        store: FuliStore,
        on_shutdown: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        let db_path_display = store
            .db_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| ":memory:".to_string());
        Self {
            endpoint,
            started_at: Instant::now(),
            shutting_down: AtomicBool::new(false),
            ui,
            store: Mutex::new(store),
            vector_cache: IdleUnloadVectorCache::new(),
            last_dreaming: Mutex::new(None),
            concierge_tasks: Mutex::new(Vec::new()),
            db_path_display,
            on_shutdown,
        }
    }

    pub fn push_concierge_task(&self, task: ConciergeTask) {
        if let Ok(mut guard) = self.concierge_tasks.lock() {
            guard.insert(0, task);
            guard.truncate(30);
        }
    }

    pub fn update_concierge_task(&self, id: &str, update: impl FnOnce(&mut ConciergeTask)) {
        if let Ok(mut guard) = self.concierge_tasks.lock()
            && let Some(t) = guard.iter_mut().find(|t| t.id == id)
        {
            update(t);
        }
    }

    pub fn snapshot_concierge_tasks(&self) -> Vec<ConciergeTask> {
        self.concierge_tasks
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn request_shutdown(&self) {
        if !self.shutting_down.swap(true, Ordering::SeqCst) {
            self.ui.terminate_if_running();
            (self.on_shutdown)();
            // Wake blocking accept() cleanly with a quick self-connection.
            let _ = send_request(&self.endpoint, &IpcRequest::Ping);
        }
    }

    /// Spawn a featherweight maintenance ticker:
    /// - Evicts on-demand vector cache after 60s idle (0 MiB retained)
    /// - Runs zero-model Layer-1 Dreaming periodically (every 6h) without blocking IPC
    pub fn spawn_background_maintenance(self: &Arc<Self>) -> thread::JoinHandle<()> {
        let state = Arc::clone(self);
        thread::spawn(move || {
            let vector_ttl = Duration::from_secs(DEFAULT_VECTOR_IDLE_TTL_SECS);
            let mut ticks = 0u64;
            while !state.shutting_down.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_secs(1));
                ticks += 1;
                if state.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                if ticks.is_multiple_of(15) {
                    state.vector_cache.evict_if_idle(vector_ttl);
                }
                if ticks.is_multiple_of(300) {
                    let should_scan =
                        state
                            .last_dreaming
                            .lock()
                            .ok()
                            .is_some_and(|g| match g.as_ref() {
                                None => true,
                                Some((at, _)) => at.elapsed().as_secs() >= DREAMING_INTERVAL_SECS,
                            });
                    if should_scan
                        && let Ok(guard) = state.store.lock()
                        && let Ok(report) = run_layer1_scan(&guard)
                        && let Ok(mut dguard) = state.last_dreaming.lock()
                    {
                        *dguard = Some((Instant::now(), report));
                    }
                }
            }
        })
    }
}

pub fn run_ipc_loop(state: Arc<DaemonState>) -> io::Result<()> {
    let listener = bind_listener(&state.endpoint)?;

    for incoming in listener.incoming() {
        if state.shutting_down.load(Ordering::SeqCst) {
            break;
        }
        let mut stream = match incoming {
            Ok(s) => s,
            Err(err) => {
                if state.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                eprintln!("fuli-context accept warning: {err}");
                continue;
            }
        };

        let request: IpcRequest = match read_frame(&mut stream) {
            Ok(req) => req,
            Err(_) => continue,
        };

        // Non-blocking FULI Concierge dispatch: returns live `ConciergeTask` in <5ms so the UI
        // orb and running-tasks panel update immediately while Tier-1 CLI wake runs lock-free!
        if let IpcRequest::UiAction { action, payload } = &request
            && action == "concierge_dispatch"
        {
            let t0 = Instant::now();
            let resp = handle_concierge_dispatch(&state, payload, t0);
            let _ = write_frame(&mut stream, &resp);
            continue;
        }

        // Non-blocking fast-path for `ask_agent`: release SQLite lock and accept loop before
        // spawning any external Tier-1 CLI wake process so concurrent Hooks/MCP calls NEVER stall!
        if let Some((default_client, default_session, args, err_code)) = match &request {
            IpcRequest::ToolCall {
                tool,
                client,
                session_id,
                arguments,
            } if tool == "ask_agent" => Some((
                client.as_deref().unwrap_or("mcp").to_string(),
                session_id.as_deref().unwrap_or("default").to_string(),
                arguments.clone(),
                "tool_error",
            )),
            IpcRequest::UiAction { action, payload } if action == "ask_agent" => Some((
                "fuli-ui".to_string(),
                "ui".to_string(),
                payload.clone(),
                "ui_action_error",
            )),
            _ => None,
        } {
            let t0 = Instant::now();
            let plan_res = match state.store.lock() {
                Ok(guard) => prepare_ask_agent_request(
                    &guard,
                    &state.vector_cache,
                    &default_client,
                    &default_session,
                    &args,
                ),
                Err(_) => {
                    let _ = write_frame(
                        &mut stream,
                        &IpcResponse::Error {
                            code: "store_lock_poisoned".into(),
                            message: "database lock poisoned".into(),
                        },
                    );
                    continue;
                }
            };
            match plan_res {
                Ok(AskAgentPlan::Immediate(outcome)) => {
                    let resp = match serde_json::to_value(outcome) {
                        Ok(data) => IpcResponse::Json {
                            elapsed_us: t0.elapsed().as_micros() as u64,
                            data,
                        },
                        Err(err) => IpcResponse::Error {
                            code: err_code.into(),
                            message: err.to_string(),
                        },
                    };
                    let _ = write_frame(&mut stream, &resp);
                }
                Ok(AskAgentPlan::RunNativeWake(pending)) => {
                    let bg_state = Arc::clone(&state);
                    let code_owned = err_code.to_string();
                    thread::spawn(move || {
                        let exec = execute_native_wake(&pending);
                        let resp = match bg_state.store.lock() {
                            Ok(guard) => match finalize_native_wake(&guard, pending, exec) {
                                Ok(outcome) => match serde_json::to_value(outcome) {
                                    Ok(data) => IpcResponse::Json {
                                        elapsed_us: t0.elapsed().as_micros() as u64,
                                        data,
                                    },
                                    Err(err) => IpcResponse::Error {
                                        code: code_owned,
                                        message: err.to_string(),
                                    },
                                },
                                Err(err) => IpcResponse::Error {
                                    code: code_owned,
                                    message: err.to_string(),
                                },
                            },
                            Err(_) => IpcResponse::Error {
                                code: "store_lock_poisoned".into(),
                                message: "database lock poisoned".into(),
                            },
                        };
                        let _ = write_frame(&mut stream, &resp);
                    });
                }
                Err(err) => {
                    let _ = write_frame(
                        &mut stream,
                        &IpcResponse::Error {
                            code: err_code.into(),
                            message: err.to_string(),
                        },
                    );
                }
            }
            continue;
        }

        let response = handle_request(&state, request);
        let _ = write_frame(&mut stream, &response);

        if state.shutting_down.load(Ordering::SeqCst) {
            break;
        }
    }

    cleanup_endpoint(&state.endpoint);
    Ok(())
}

pub fn handle_request(state: &DaemonState, request: IpcRequest) -> IpcResponse {
    match request {
        IpcRequest::Ping => {
            let (ui_pid, ui_state) = state.ui.snapshot();
            IpcResponse::Pong {
                version: env!("CARGO_PKG_VERSION").to_string(),
                pid: std::process::id(),
                memory: current_process_memory(),
                ui_pid,
                ui_state,
                uptime_secs: state.started_at.elapsed().as_secs(),
                db_path: state.db_path_display.clone(),
            }
        }
        IpcRequest::OpenUi => match state.ui.open_or_focus() {
            Ok((pid, already_running)) => IpcResponse::UiOpened {
                pid,
                already_running,
            },
            Err(err) => IpcResponse::Error {
                code: "ui_spawn_failed".into(),
                message: err.to_string(),
            },
        },
        IpcRequest::NotifyUiClosing { .. } => {
            state.ui.mark_grace_closing();
            IpcResponse::Ack
        }
        IpcRequest::HookPrompt {
            client,
            cwd,
            session_id,
            event,
            user_prompt,
        } => {
            let t0 = Instant::now();
            let guard = match state.store.lock() {
                Ok(g) => g,
                Err(_) => {
                    return IpcResponse::Error {
                        code: "store_lock_poisoned".into(),
                        message: "database lock poisoned".into(),
                    };
                }
            };
            match handle_hook_event(
                &guard,
                &client,
                event.as_deref().unwrap_or("prompt"),
                &cwd,
                session_id.as_deref(),
                user_prompt.as_deref(),
            ) {
                Ok((summary, packet)) => IpcResponse::HookReply {
                    elapsed_us: t0.elapsed().as_micros() as u64,
                    summary,
                    packet: Some(packet),
                },
                Err(err) => IpcResponse::Error {
                    code: "hook_error".into(),
                    message: err.to_string(),
                },
            }
        }
        IpcRequest::ToolCall {
            tool,
            client,
            session_id,
            arguments,
        } => {
            let t0 = Instant::now();
            let guard = match state.store.lock() {
                Ok(g) => g,
                Err(_) => {
                    return IpcResponse::Error {
                        code: "store_lock_poisoned".into(),
                        message: "database lock poisoned".into(),
                    };
                }
            };
            match dispatch_tool(
                &guard,
                &state.vector_cache,
                &tool,
                client.as_deref().unwrap_or("mcp"),
                session_id.as_deref().unwrap_or("default"),
                &arguments,
            ) {
                Ok(data) => IpcResponse::Json {
                    elapsed_us: t0.elapsed().as_micros() as u64,
                    data,
                },
                Err(err) => IpcResponse::Error {
                    code: "tool_error".into(),
                    message: err.to_string(),
                },
            }
        }
        IpcRequest::DashboardSnapshot => {
            let t0 = Instant::now();
            let tasks = state.snapshot_concierge_tasks();
            let guard = match state.store.lock() {
                Ok(g) => g,
                Err(_) => {
                    return IpcResponse::Error {
                        code: "store_lock_poisoned".into(),
                        message: "database lock poisoned".into(),
                    };
                }
            };
            match build_dashboard_snapshot(&guard, &state.vector_cache, &tasks) {
                Ok(data) => IpcResponse::Json {
                    elapsed_us: t0.elapsed().as_micros() as u64,
                    data,
                },
                Err(err) => IpcResponse::Error {
                    code: "snapshot_error".into(),
                    message: err.to_string(),
                },
            }
        }
        IpcRequest::UiAction { action, payload } => {
            let t0 = Instant::now();
            let guard = match state.store.lock() {
                Ok(g) => g,
                Err(_) => {
                    return IpcResponse::Error {
                        code: "store_lock_poisoned".into(),
                        message: "database lock poisoned".into(),
                    };
                }
            };
            match handle_ui_action(&guard, &state.vector_cache, &action, &payload) {
                Ok(data) => IpcResponse::Json {
                    elapsed_us: t0.elapsed().as_micros() as u64,
                    data,
                },
                Err(err) => IpcResponse::Error {
                    code: "ui_action_error".into(),
                    message: err.to_string(),
                },
            }
        }
        IpcRequest::Shutdown => {
            state.shutting_down.store(true, Ordering::SeqCst);
            state.ui.terminate_if_running();
            (state.on_shutdown)();
            IpcResponse::Ack
        }
    }
}

fn handle_concierge_dispatch(
    state: &Arc<DaemonState>,
    payload: &serde_json::Value,
    t0: Instant,
) -> IpcResponse {
    let req = match parse_concierge_preview_request(payload) {
        Ok(r) => r,
        Err(err) => {
            return IpcResponse::Error {
                code: "ui_action_error".into(),
                message: err.to_string(),
            };
        }
    };
    let was_corrected = payload
        .get("was_corrected")
        .or_else(|| payload.get("wasCorrected"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let (preview, prep) = {
        let guard = match state.store.lock() {
            Ok(g) => g,
            Err(_) => {
                return IpcResponse::Error {
                    code: "store_lock_poisoned".into(),
                    message: "database lock poisoned".into(),
                };
            }
        };
        let preview = match preview_concierge_route(&guard, Some(&state.vector_cache), &req) {
            Ok(p) => p,
            Err(err) => {
                return IpcResponse::Error {
                    code: "ui_action_error".into(),
                    message: err.to_string(),
                };
            }
        };
        if was_corrected && let Some(ref aid) = preview.selected_agent_id {
            let _ = record_concierge_route_correction(&guard, &preview.prompt, aid);
        }
        let prep = match prepare_concierge_dispatch(&guard, Some(&state.vector_cache), &preview) {
            Ok(p) => p,
            Err(err) => {
                return IpcResponse::Error {
                    code: "ui_action_error".into(),
                    message: err.to_string(),
                };
            }
        };
        (preview, prep)
    };

    let task_id = new_id();
    let mut task = new_concierge_task(task_id.clone(), &preview, was_corrected);

    match prep {
        ConciergeDispatchPrep::ImmediateOverview {
            exchange_id,
            answer,
        } => {
            task.status = ConciergeTaskStatus::Completed;
            task.step_label = "大管家已汇总全部项目与会话实况（0 Token）".to_string();
            task.result_preview = Some(answer);
            task.exchange_id = Some(exchange_id);
            task.finished_at = Some(now_rfc3339());
            task.elapsed_ms = t0.elapsed().as_millis() as u64;
            state.push_concierge_task(task.clone());
            IpcResponse::Json {
                elapsed_us: t0.elapsed().as_micros() as u64,
                data: serde_json::json!({ "task": task, "async": false }),
            }
        }
        ConciergeDispatchPrep::Roundtable(plan) => match *plan {
            AskAgentPlan::Immediate(outcome) => {
                task.status = ConciergeTaskStatus::Completed;
                task.step_label = match outcome.tier {
                    RoundtableTier::MemoryFastPath => {
                        "记忆直答完成（0 Token · 未打扰目标会话）".to_string()
                    }
                    RoundtableTier::NativeCliWake => {
                        format!("{} 已回复", client_display_name(&task.target_client))
                    }
                    RoundtableTier::QueuedInbox => format!(
                        "已送达 {} 收件箱，下轮交互自动捎带",
                        client_display_name(&task.target_client)
                    ),
                };
                task.result_preview = outcome.exchange.answer.clone().or_else(|| {
                    Some(format!(
                        "已入队 {} 收件箱（会话 {}），目标客户端下轮 Prompt 自动收到并可一键回复。",
                        client_display_name(&task.target_client),
                        task.target_session_id
                    ))
                });
                task.exchange_id = Some(outcome.exchange.id.clone());
                task.finished_at = Some(now_rfc3339());
                task.elapsed_ms = t0.elapsed().as_millis() as u64;
                state.push_concierge_task(task.clone());
                IpcResponse::Json {
                    elapsed_us: t0.elapsed().as_micros() as u64,
                    data: serde_json::json!({ "task": task, "outcome": outcome, "async": false }),
                }
            }
            AskAgentPlan::RunNativeWake(pending) => {
                state.push_concierge_task(task.clone());
                let bg_state = Arc::clone(state);
                let bg_task_id = task_id.clone();
                let target_client_name = client_display_name(&task.target_client);
                thread::spawn(move || {
                    let exec = execute_native_wake(&pending);
                    let finalized = bg_state
                        .store
                        .lock()
                        .ok()
                        .and_then(|guard| finalize_native_wake(&guard, pending, exec).ok());
                    let elapsed_ms = t0.elapsed().as_millis() as u64;
                    let done_at = now_rfc3339();
                    bg_state.update_concierge_task(&bg_task_id, |t| {
                        t.elapsed_ms = elapsed_ms;
                        t.finished_at = Some(done_at);
                        match finalized {
                            Some(outcome) => {
                                t.exchange_id = Some(outcome.exchange.id.clone());
                                if outcome.tier == RoundtableTier::NativeCliWake {
                                    t.status = ConciergeTaskStatus::Completed;
                                    t.step_label = format!("{target_client_name} 原生会话已回复");
                                    t.result_preview = outcome.exchange.answer.clone();
                                } else {
                                    t.status = ConciergeTaskStatus::NeedsAttention;
                                    t.step_label = format!(
                                        "{target_client_name} 暂未在线，已自动转入收件箱等下轮捎带"
                                    );
                                    t.result_preview = Some(format!(
                                        "本地唤醒回退（{}），已安全存入收件箱，对方下次交互将自动收到。",
                                        outcome.fallback_reason.as_deref().unwrap_or("queued")
                                    ));
                                }
                            }
                            None => {
                                t.status = ConciergeTaskStatus::Failed;
                                t.step_label = "本地落盘失败，请重试".to_string();
                            }
                        }
                    });
                });
                IpcResponse::Json {
                    elapsed_us: t0.elapsed().as_micros() as u64,
                    data: serde_json::json!({ "task": task, "async": true }),
                }
            }
        },
    }
}
