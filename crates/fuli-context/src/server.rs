use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use fuli_dreaming::{DreamingReport, run_layer1_scan};
use fuli_ipc::{
    IpcRequest, IpcResponse, ListenerExt as _, bind_listener, cleanup_endpoint, read_frame,
    send_request, write_frame,
};
use fuli_search::{DEFAULT_VECTOR_IDLE_TTL_SECS, IdleUnloadVectorCache};
use fuli_store::FuliStore;

use crate::dispatch::{
    build_dashboard_snapshot, dispatch_tool, handle_hook_event, handle_ui_action,
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
            db_path_display,
            on_shutdown,
        }
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
            let guard = match state.store.lock() {
                Ok(g) => g,
                Err(_) => {
                    return IpcResponse::Error {
                        code: "store_lock_poisoned".into(),
                        message: "database lock poisoned".into(),
                    };
                }
            };
            match build_dashboard_snapshot(&guard, &state.vector_cache) {
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
