use std::io::{self, BufRead, BufReader, Write};

use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, Listener, ListenerOptions, Name, NameType, Stream,
    ToFsName, ToNsName, traits::Stream as _,
};
use serde::{Deserialize, Serialize};

pub use interprocess::local_socket::traits::ListenerExt;

pub const DEFAULT_IPC_NAME: &str = "fuli-context-next";
pub const IPC_NAME_ENV: &str = "FULI_IPC_NAME";
const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiLifecycleState {
    Stopped,
    Running,
    GraceClosing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySnapshot {
    pub working_set_bytes: u64,
    pub private_bytes: u64,
}

impl MemorySnapshot {
    pub fn working_set_mib(&self) -> f64 {
        self.working_set_bytes as f64 / (1024.0 * 1024.0)
    }

    pub fn private_mib(&self) -> f64 {
        self.private_bytes as f64 / (1024.0 * 1024.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcRequest {
    Ping,
    OpenUi,
    NotifyUiClosing {
        grace_secs: u64,
    },
    HookPrompt {
        client: String,
        cwd: String,
        session_id: Option<String>,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcResponse {
    Pong {
        version: String,
        pid: u32,
        memory: MemorySnapshot,
        ui_pid: Option<u32>,
        ui_state: UiLifecycleState,
        uptime_secs: u64,
    },
    UiOpened {
        pid: u32,
        already_running: bool,
    },
    HookReply {
        elapsed_us: u64,
        summary: String,
    },
    Ack,
    Error {
        code: String,
        message: String,
    },
}

pub fn resolve_ipc_name(explicit: Option<&str>) -> String {
    if let Some(name) = explicit.filter(|value| !value.trim().is_empty()) {
        return name.trim().to_string();
    }
    if let Ok(env_name) = std::env::var(IPC_NAME_ENV)
        && !env_name.trim().is_empty()
    {
        return env_name.trim().to_string();
    }
    DEFAULT_IPC_NAME.to_string()
}

pub fn socket_name(endpoint: &str) -> io::Result<Name<'static>> {
    if GenericNamespaced::is_supported() {
        let ns = format!("{endpoint}.sock");
        ns.to_ns_name::<GenericNamespaced>().map(Name::into_owned)
    } else {
        let path = unix_socket_path(endpoint);
        path.to_fs_name::<GenericFilePath>().map(Name::into_owned)
    }
}

#[cfg_attr(windows, allow(dead_code))]
pub fn unix_socket_path(endpoint: &str) -> std::path::PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let safe = endpoint
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    base.join(format!("{safe}.sock"))
}

pub fn bind_listener(endpoint: &str) -> io::Result<Listener> {
    if !GenericNamespaced::is_supported() {
        let path = unix_socket_path(endpoint);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    let name = socket_name(endpoint)?;
    ListenerOptions::new().name(name).create_sync()
}

pub fn cleanup_endpoint(endpoint: &str) {
    if !GenericNamespaced::is_supported() {
        let path = unix_socket_path(endpoint);
        let _ = std::fs::remove_file(path);
    }
}

pub fn send_request(endpoint: &str, request: &IpcRequest) -> io::Result<IpcResponse> {
    let name = socket_name(endpoint)?;
    let mut stream = Stream::connect(name)?;
    write_frame(&mut stream, request)?;
    read_frame(&mut stream)
}

pub fn write_frame<T: Serialize, W: Write>(writer: &mut W, payload: &T) -> io::Result<()> {
    let mut line = serde_json::to_vec(payload)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    line.push(b'\n');
    writer.write_all(&line)?;
    writer.flush()
}

pub fn read_frame<T: for<'de> Deserialize<'de>, R: io::Read>(reader: &mut R) -> io::Result<T> {
    let mut buf_reader = BufReader::new(reader);
    let mut raw = Vec::with_capacity(256);
    let mut total = 0usize;
    loop {
        let available = buf_reader.fill_buf()?;
        if available.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "IPC peer closed before completing frame",
            ));
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            total += pos;
            if total > MAX_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "IPC frame exceeded limit",
                ));
            }
            raw.extend_from_slice(&available[..pos]);
            buf_reader.consume(pos + 1);
            break;
        }
        total += available.len();
        if total > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "IPC frame exceeded limit",
            ));
        }
        raw.extend_from_slice(available);
        let len = available.len();
        buf_reader.consume(len);
    }
    serde_json::from_slice(&raw).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_endpoint(tag: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        format!("fuli-ipc-test-{tag}-{}-{nanos}", std::process::id())
    }

    #[test]
    fn round_trip_ping_and_hook_over_local_ipc() {
        let endpoint = unique_endpoint("rt");
        let listener = bind_listener(&endpoint).expect("bind test listener");

        let server_ep = endpoint.clone();
        let handle = thread::spawn(move || {
            for incoming in listener.incoming().take(2) {
                let mut stream = incoming.expect("accept stream");
                let req: IpcRequest = read_frame(&mut stream).expect("read request");
                let resp = match req {
                    IpcRequest::Ping => IpcResponse::Pong {
                        version: "2.0.0-alpha.0".into(),
                        pid: 42,
                        memory: MemorySnapshot {
                            working_set_bytes: 16 * 1024 * 1024,
                            private_bytes: 12 * 1024 * 1024,
                        },
                        ui_pid: None,
                        ui_state: UiLifecycleState::Stopped,
                        uptime_secs: 5,
                    },
                    IpcRequest::HookPrompt { client, cwd, .. } => IpcResponse::HookReply {
                        elapsed_us: 120,
                        summary: format!("{client}@{cwd}"),
                    },
                    _ => IpcResponse::Ack,
                };
                write_frame(&mut stream, &resp).expect("write response");
            }
            cleanup_endpoint(&server_ep);
        });

        let pong = send_request(&endpoint, &IpcRequest::Ping).expect("send ping");
        match pong {
            IpcResponse::Pong {
                pid,
                ui_state,
                memory,
                ..
            } => {
                assert_eq!(pid, 42);
                assert_eq!(ui_state, UiLifecycleState::Stopped);
                assert!((memory.working_set_mib() - 16.0).abs() < 0.01);
            }
            other => panic!("unexpected ping response: {other:?}"),
        }

        let hook = send_request(
            &endpoint,
            &IpcRequest::HookPrompt {
                client: "claude-code".into(),
                cwd: "t:/workspace/fuli".into(),
                session_id: Some("sess-1".into()),
            },
        )
        .expect("send hook");
        assert_eq!(
            hook,
            IpcResponse::HookReply {
                elapsed_us: 120,
                summary: "claude-code@t:/workspace/fuli".into(),
            }
        );

        handle.join().expect("server thread finished cleanly");
    }
}
