use fuli_ipc::MemorySnapshot;

#[cfg(windows)]
pub fn current_process_memory() -> MemorySnapshot {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = zeroed();
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            counters.cb,
        );
        if ok != 0 {
            MemorySnapshot {
                working_set_bytes: counters.WorkingSetSize as u64,
                private_bytes: counters.PrivateUsage as u64,
            }
        } else {
            MemorySnapshot {
                working_set_bytes: 0,
                private_bytes: 0,
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn current_process_memory() -> MemorySnapshot {
    use std::mem::zeroed;
    unsafe {
        let mut usage: libc::rusage = zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) == 0 {
            let bytes = usage.ru_maxrss.max(0) as u64;
            MemorySnapshot {
                working_set_bytes: bytes,
                private_bytes: bytes,
            }
        } else {
            MemorySnapshot {
                working_set_bytes: 0,
                private_bytes: 0,
            }
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn current_process_memory() -> MemorySnapshot {
    if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
        let mut parts = statm.split_whitespace();
        let _total = parts.next();
        if let Some(resident_pages) = parts.next().and_then(|v| v.parse::<u64>().ok()) {
            let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE).max(4096) as u64 };
            let bytes = resident_pages * page_size;
            return MemorySnapshot {
                working_set_bytes: bytes,
                private_bytes: bytes,
            };
        }
    }
    MemorySnapshot {
        working_set_bytes: 0,
        private_bytes: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_nonzero_process_memory() {
        let snapshot = current_process_memory();
        assert!(snapshot.working_set_bytes > 0);
    }
}
