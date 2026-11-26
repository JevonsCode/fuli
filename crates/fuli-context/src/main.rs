mod memory;
mod server;
mod tray;
mod ui_process;

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use fuli_ipc::resolve_ipc_name;
use server::{DaemonState, run_ipc_loop};
use ui_process::UiProcessManager;

struct Config {
    headless: bool,
    ipc_endpoint: String,
    ui_bin: Option<PathBuf>,
    ui_grace_secs: u64,
}

fn parse_args() -> Config {
    let mut headless = false;
    let mut ipc_name = None;
    let mut ui_bin = None;
    let mut ui_grace_secs = 30u64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--headless" | "--no-tray" => headless = true,
            "--ipc-name" => ipc_name = args.next(),
            "--ui-bin" => ui_bin = args.next().map(PathBuf::from),
            "--ui-grace-secs" => {
                if let Some(raw) = args.next()
                    && let Ok(parsed) = raw.parse::<u64>()
                {
                    ui_grace_secs = parsed;
                }
            }
            _ => {}
        }
    }

    Config {
        headless,
        ipc_endpoint: resolve_ipc_name(ipc_name.as_deref()),
        ui_bin,
        ui_grace_secs,
    }
}

fn main() {
    let cfg = parse_args();
    let ui = UiProcessManager::new(cfg.ui_bin, cfg.ipc_endpoint.clone(), cfg.ui_grace_secs);

    let state = Arc::new(DaemonState::new(
        cfg.ipc_endpoint.clone(),
        ui,
        Box::new(|| {}),
    ));

    if cfg.headless {
        if let Err(err) = run_ipc_loop(Arc::clone(&state)) {
            eprintln!("fuli-context IPC exited with error: {err}");
            std::process::exit(1);
        }
        return;
    }

    let ipc_state = Arc::clone(&state);
    let ipc_thread = thread::spawn(move || {
        if let Err(err) = run_ipc_loop(ipc_state) {
            eprintln!("fuli-context IPC error: {err}");
        }
    });

    if let Err(err) = tray::run_tray_loop(Arc::clone(&state)) {
        eprintln!("fuli-context tray unavailable ({err}); continuing headless");
    }

    state.request_shutdown();
    let _ = ipc_thread.join();
}
