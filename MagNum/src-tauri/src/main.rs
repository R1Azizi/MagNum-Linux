
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;


/// دریافت دو پورت آزاد همزمان برای جلوگیری از تداخل CDP و Backend
fn get_free_ports() -> (u16, u16) {
    let listener_cdp = TcpListener::bind("127.0.0.1:0").ok();
    let listener_backend = TcpListener::bind("127.0.0.1:0").ok();

    let cdp_port = listener_cdp
        .as_ref()
        .and_then(|l| l.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(9222);

    let backend_port = listener_backend
        .as_ref()
        .and_then(|l| l.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(5454);

    // NOTE: listeners are intentionally dropped here. server.js now retries the
    // same port several times on EADDRINUSE before falling back to a dynamic
    // port, which eliminates the previous race where another process grabbed
    // the freshly-freed port and the UI hung waiting on a stale .backend-port.
    drop(listener_cdp);
    drop(listener_backend);

    (cdp_port, backend_port)
}

fn main() {
    let (cdp_port, backend_port) = get_free_ports();

    unsafe {
        std::env::set_var("MAGNUM_CDP_PORT", cdp_port.to_string());
        std::env::set_var("MAGNUM_BACKEND_PORT", backend_port.to_string());

        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("--remote-debugging-port={}", cdp_port),
        );

        // Linux/WebKitGTK: prevent GTK from bailing out (SIGTRAP) when glycin's
        // sandboxed SVG loader cannot load icons. Disabling the glycin sandbox
        // avoids the failing bwrap invocation entirely.
        #[cfg(target_os = "linux")]
        {
            std::env::set_var("GLYCIN_SANDBOX", "none");
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    magnum_lib::run()
}
