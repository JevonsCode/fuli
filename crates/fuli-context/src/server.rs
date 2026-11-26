use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use fuli_ipc::{
    IpcRequest, IpcResponse, ListenerExt as _, bind_listener, cleanup_endpoint, read_frame,
    send_request, write_frame,
};

use crate::memory::current_process_memory;
use crate::ui_process::UiProcessManager;

pub struct DaemonState {
    pub endpoint: String,
    pub started_at: Instant,
    pub shutting_down: AtomicBool,
    pub ui: UiProcessManager,
    on_shutdown: Box<dyn Fn() + Send + Sync>,
}

impl DaemonState {
    pub fn new(
        endpoint: String,
        ui: UiProcessManager,
        on_shutdown: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            endpoint,
            started_at: Instant::now(),
            shutting_down: AtomicBool::new(false),
            ui,
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

fn handle_request(state: &DaemonState, request: IpcRequest) -> IpcResponse {
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
        } => {
            let t0 = Instant::now();
            let sess = session_id.as_deref().unwrap_or("none");
            let summary = format!("fuli-context ready · client={client} cwd={cwd} session={sess}");
            IpcResponse::HookReply {
                elapsed_us: t0.elapsed().as_micros() as u64,
                summary,
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
