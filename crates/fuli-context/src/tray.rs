use std::sync::Arc;

use crate::server::DaemonState;

/// Pure-code 32x32 RGBA FULI tray icon (ink dark circle + gold/white compounding arcs).
/// Avoids pulling PNG/image decoding crates into the resident daemon.
fn build_tray_rgba() -> (Vec<u8>, u32, u32) {
    let size = 32u32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let center = 15.5_f32;
    let radius = 14.5_f32;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let idx = ((y * size + x) * 4) as usize;
            if dist <= radius {
                // Default ink badge background (#17171a)
                let (mut r, mut g, mut b, a) = (0x17u8, 0x17u8, 0x1au8, 0xffu8);

                // Outer compounding gold arc (#a8824a)
                let adx = x as f32 - 22.0;
                let ady = y as f32 - 22.0;
                let arc_d = (adx * adx + ady * ady).sqrt();
                if x <= 23 && y <= 23 && (arc_d - 13.0).abs() < 1.65 {
                    (r, g, b) = (0xa8, 0x82, 0x4a);
                }
                // Inner white arc
                if x <= 23 && y <= 23 && (arc_d - 8.2).abs() < 1.45 {
                    (r, g, b) = (0xff, 0xff, 0xff);
                }
                // Accent gold dot at bottom-right
                let ddx = x as f32 - 21.5;
                let ddy = y as f32 - 21.5;
                if (ddx * ddx + ddy * ddy).sqrt() <= 2.3 {
                    (r, g, b) = (0xa8, 0x82, 0x4a);
                }

                rgba[idx] = r;
                rgba[idx + 1] = g;
                rgba[idx + 2] = b;
                rgba[idx + 3] = a;
            }
        }
    }
    (rgba, size, size)
}

#[cfg(windows)]
pub fn run_tray_loop(state: Arc<DaemonState>) -> std::io::Result<()> {
    use std::mem::zeroed;
    use std::sync::atomic::Ordering;
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage, WM_QUIT,
    };

    let (rgba, w, h) = build_tray_rgba();
    let icon = Icon::from_rgba(rgba, w, h)
        .map_err(|err| std::io::Error::other(format!("tray icon error: {err}")))?;

    let item_open = MenuItem::new("打开 FULI / Open FULI", true, None);
    let item_status = MenuItem::new("fuli-context 运行中 (低内存常驻)", false, None);
    let item_quit = MenuItem::new("退出 FULI / Quit", true, None);

    let open_id = item_open.id().clone();
    let quit_id = item_quit.id().clone();

    let menu = Menu::new();
    let _ = menu.append(&item_open);
    let _ = menu.append(&item_status);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&item_quit);

    let _tray = TrayIconBuilder::new()
        .with_tooltip("FULI 复利 · 低内存后台核心")
        .with_menu(Box::new(menu))
        .with_icon(icon)
        .build()
        .map_err(|err| std::io::Error::other(format!("tray build error: {err}")))?;

    let menu_rx = MenuEvent::receiver();
    let tray_rx = TrayIconEvent::receiver();

    unsafe {
        let mut msg: MSG = zeroed();
        while !state.shutting_down.load(Ordering::SeqCst) {
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                if msg.message == WM_QUIT {
                    state.request_shutdown();
                    return Ok(());
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            while let Ok(event) = menu_rx.try_recv() {
                if event.id == open_id {
                    if let Err(err) = state.ui.open_or_focus() {
                        eprintln!("fuli-context open UI failed: {err}");
                    }
                } else if event.id == quit_id {
                    state.request_shutdown();
                    return Ok(());
                }
            }

            while let Ok(event) = tray_rx.try_recv() {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                    && let Err(err) = state.ui.open_or_focus()
                {
                    eprintln!("fuli-context open UI failed: {err}");
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn run_tray_loop(state: Arc<DaemonState>) -> std::io::Result<()> {
    use std::sync::atomic::Ordering;
    let _ = build_tray_rgba();
    // On macOS / Linux, native NSApplication / GTK tray loop wiring lands alongside macOS M3 polish;
    // keep the daemon cleanly alive until Shutdown is requested over IPC.
    while !state.shutting_down.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(())
}
