use std::io;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use fuli_ipc::UiLifecycleState;

pub struct UiProcessManager {
    ui_binary: PathBuf,
    ipc_endpoint: String,
    close_grace_secs: u64,
    state: Mutex<UiTrack>,
}

struct UiTrack {
    child: Option<Child>,
    lifecycle: UiLifecycleState,
}

impl UiProcessManager {
    pub fn new(ui_binary: Option<PathBuf>, ipc_endpoint: String, close_grace_secs: u64) -> Self {
        let resolved = ui_binary.unwrap_or_else(default_sibling_ui_path);
        Self {
            ui_binary: resolved,
            ipc_endpoint,
            close_grace_secs,
            state: Mutex::new(UiTrack {
                child: None,
                lifecycle: UiLifecycleState::Stopped,
            }),
        }
    }

    pub fn snapshot(&self) -> (Option<u32>, UiLifecycleState) {
        let mut guard = self.state.lock().expect("ui state lock");
        reap_if_exited(&mut guard);
        let pid = guard.child.as_ref().map(Child::id);
        (pid, guard.lifecycle)
    }

    pub fn mark_grace_closing(&self) {
        let mut guard = self.state.lock().expect("ui state lock");
        reap_if_exited(&mut guard);
        if guard.child.is_some() {
            guard.lifecycle = UiLifecycleState::GraceClosing;
        }
    }

    pub fn open_or_focus(&self) -> io::Result<(u32, bool)> {
        let mut guard = self.state.lock().expect("ui state lock");
        reap_if_exited(&mut guard);

        if let Some(child) = guard.child.as_ref()
            && guard.lifecycle == UiLifecycleState::Running
        {
            return Ok((child.id(), true));
        }

        // If a previous UI process is sitting in its close grace window, kill it
        // cleanly and spawn a fresh window so open always succeeds predictably.
        if let Some(mut old) = guard.child.take() {
            let _ = old.kill();
            let _ = old.wait();
        }

        if !self.ui_binary.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("fuli-ui binary not found at {}", self.ui_binary.display()),
            ));
        }

        let child = Command::new(&self.ui_binary)
            .arg("--ipc-name")
            .arg(&self.ipc_endpoint)
            .arg("--close-grace-secs")
            .arg(self.close_grace_secs.to_string())
            .spawn()?;

        let pid = child.id();
        guard.child = Some(child);
        guard.lifecycle = UiLifecycleState::Running;
        Ok((pid, false))
    }

    pub fn terminate_if_running(&self) {
        let mut guard = self.state.lock().expect("ui state lock");
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        guard.lifecycle = UiLifecycleState::Stopped;
    }
}

fn reap_if_exited(track: &mut UiTrack) {
    if let Some(child) = track.child.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => {
                track.child = None;
                track.lifecycle = UiLifecycleState::Stopped;
            }
            Ok(None) => {}
        }
    } else {
        track.lifecycle = UiLifecycleState::Stopped;
    }
}

fn default_sibling_ui_path() -> PathBuf {
    let bin_name = if cfg!(windows) {
        "fuli-ui.exe"
    } else {
        "fuli-ui"
    };
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        return dir.join(bin_name);
    }
    PathBuf::from(bin_name)
}
