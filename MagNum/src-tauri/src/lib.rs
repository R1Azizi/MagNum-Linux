#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::Manager;

// Shared tool executor used on Android (and reusable on desktop later).
#[allow(unused_imports)]
use magnum_core::{Action, ActionResult, Dispatcher, NullBrowser, NullFs};

/// Smoke-check that the shared core links and dispatches.
#[tauri::command]
fn core_selftest() -> Result<String, String> {
    let d = Dispatcher { browser: NullBrowser, fs: NullFs };
    let a = Action { action: "read_files".into(), params: serde_json::json!({ "file": "x" }) };
    let r: ActionResult = d.dispatch(a);
    serde_json::to_string(&r).map_err(|e| e.to_string())
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct AppState {
    pub server: Mutex<Option<Child>>,
    #[cfg(windows)]
    pub job: Mutex<usize>,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
unsafe extern "system" {
    fn CreateJobObjectW(sa: *mut std::ffi::c_void, name: *const u16) -> *mut std::ffi::c_void;
    fn SetInformationJobObject(
        job: *mut std::ffi::c_void,
        info_class: i32,
        info: *mut std::ffi::c_void,
        info_len: u32,
    ) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void) -> i32;
    fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
#[cfg(windows)]
const PROCESS_ALL_ACCESS: u32 = 0x001F0FFF;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("invalid url".into());
    }
    
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// On Linux, Tauri packs child webviews into the window's vertical GtkBox, so they
/// stack *below* the main webview instead of floating over it. Re-parent the embedded
/// browser into a GtkOverlay on top of the main webview and position it with margins.
#[cfg(target_os = "linux")]
#[tauri::command]
fn place_embedded_browser(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    use gtk::prelude::*;

    let wv = app
        .get_webview("magnum-embedded-browser")
        .ok_or_else(|| "embedded browser not found".to_string())?;
    wv.with_webview(move |pv| {
        let child: gtk::Widget = pv.inner().upcast();
        let Some(parent) = child.parent() else { return };

        let overlay = if let Ok(ov) = parent.clone().downcast::<gtk::Overlay>() {
            ov
        } else if let Ok(vbox) = parent.downcast::<gtk::Box>() {
            let main = vbox
                .children()
                .into_iter()
                .find(|c| *c != child && c.type_().name() == "WebKitWebView");
            let Some(main) = main else { return };
            let ov = gtk::Overlay::new();
            vbox.remove(&main);
            vbox.remove(&child);
            ov.add(&main);
            ov.add_overlay(&child);
            ov.set_overlay_pass_through(&child, false);
            vbox.pack_start(&ov, true, true, 0);
            ov.show();
            main.show();
            ov
        } else {
            return;
        };
        let _ = overlay;

        child.set_halign(gtk::Align::Start);
        child.set_valign(gtk::Align::Start);
        child.set_margin_start(x.max(0));
        child.set_margin_top(y.max(0));
        child.set_size_request(width.max(10), height.max(10));
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn place_embedded_browser(_x: i32, _y: i32, _width: i32, _height: i32) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn set_app_theme(window: tauri::Window, theme: String) -> Result<(), String> {
    match theme.as_str() {
        "light" => window.set_theme(Some(tauri::Theme::Light)).map_err(|e| e.to_string()),
        "dark" => window.set_theme(Some(tauri::Theme::Dark)).map_err(|e| e.to_string()),
        _ => window.set_theme(None).map_err(|e| e.to_string()),
    }
}



#[tauri::command]
fn read_ws_token(app_handle: tauri::AppHandle) -> Result<String, String> {
    
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .or_else(|_| {
            if cfg!(target_os = "windows") {
                std::env::var("APPDATA")
                    .map(|appdata| std::path::PathBuf::from(appdata).join("MagNum"))
                    .map_err(|e| e.to_string())
            } else {
                std::env::var("HOME")
                    .map(|home| std::path::PathBuf::from(home).join(".magnum"))
                    .map_err(|e| e.to_string())
            }
        })
        .map_err(|e| format!("Failed to resolve data dir: {}", e))?;

    let token_file = data_dir.join(".ws-token");

    
    if !token_file.exists() {
        return Err(format!("Token file not found: {:?}", token_file));
    }

    
    let token = std::fs::read_to_string(&token_file)
        .map_err(|e| format!("Failed to read token file: {}", e))?;

    let trimmed = token.trim().to_string();

    
    if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid token format".to_string());
    }

    Ok(trimmed)
}

#[tauri::command]
fn get_backend_port(app_handle: tauri::AppHandle) -> Result<u16, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .or_else(|_| {
            if cfg!(target_os = "windows") {
                std::env::var("APPDATA")
                    .map(|appdata| std::path::PathBuf::from(appdata).join("MagNum"))
                    .map_err(|e| e.to_string())
            } else {
                std::env::var("HOME")
                    .map(|home| std::path::PathBuf::from(home).join(".magnum"))
                    .map_err(|e| e.to_string())
            }
        })
        .map_err(|e| format!("Failed to resolve data dir: {}", e))?;

    let port_file = data_dir.join(".backend-port");
    if port_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = content.trim().parse::<u16>() {
                if port > 0 {
                    return Ok(port);
                }
            }
        }
    }

    std::env::var("MAGNUM_BACKEND_PORT")
        .map_err(|_| "MAGNUM_BACKEND_PORT not set".to_string())
        .and_then(|p| p.parse::<u16>().map_err(|e| e.to_string()))
}

/// Command that waits (up to ~10s) for `.backend-port` to appear, so the UI
/// never reads a stale value while the freshly-spawned server is still binding.
#[tauri::command]
async fn wait_backend_port(app_handle: tauri::AppHandle) -> Result<u16, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .or_else(|_| {
            if cfg!(target_os = "windows") {
                std::env::var("APPDATA")
                    .map(|appdata| std::path::PathBuf::from(appdata).join("MagNum"))
                    .map_err(|e| e.to_string())
            } else {
                std::env::var("HOME")
                    .map(|home| std::path::PathBuf::from(home).join(".magnum"))
                    .map_err(|e| e.to_string())
            }
        })
        .map_err(|e| format!("Failed to resolve data dir: {}", e))?;

    let port_file = data_dir.join(".backend-port");
    let fallback: u16 = std::env::var("MAGNUM_BACKEND_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(5454);

    // Poll for up to ~10 seconds for the server to write a fresh port.
    for _ in 0..50 {
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = content.trim().parse::<u16>() {
                if port > 0 {
                    return Ok(port);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    Ok(fallback)
}

/// Resolve the node binary on non-Windows: MAGNUM_NODE, bundled `backend/node`, then PATH.
#[cfg(not(windows))]
fn resolve_node(backend_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("MAGNUM_NODE") {
        if !p.is_empty() {
            let p = std::path::PathBuf::from(p);
            return if p.is_file() {
                Ok(p)
            } else {
                Err(format!("MAGNUM_NODE points to a missing file: {}", p.display()))
            };
        }
    }
    let bundled = backend_dir.join("node");
    if bundled.is_file() {
        return Ok(bundled);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("node");
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    Err("Node.js not found: install node, put it on PATH, or set MAGNUM_NODE".into())
}

/// SIGTERM the backend's process group, reap the leader, then SIGKILL any survivors.
#[cfg(unix)]
fn kill_process_group(child: &mut Child) {
    let pgid = -(child.id() as libc::pid_t);
    unsafe { libc::kill(pgid, libc::SIGTERM) };
    for _ in 0..10 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    unsafe { libc::kill(pgid, libc::SIGKILL) };
    let _ = child.wait();
}

#[tauri::command]
async fn pick_folder(_window: tauri::Window) -> Result<Option<String>, String> {
    // Native folder selection is delegated to the backend (`choose_folder`),
    // which uses zenity/kdialog on Linux, osascript on macOS, and PowerShell on Windows.
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_provider::init());

    // Desktop-only plugins (single-instance, updater, process) are not
    // available on Android.
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            server: Mutex::new(None),
            #[cfg(windows)]
            job: Mutex::new(0),
        })
        .setup(|app| {
            // Android provider chat uses the in-process mobile plugin.
            #[cfg(not(target_os = "android"))]
            {
            let resource_dir = app.path().resource_dir().expect("resource dir");
            let backend_dir = resource_dir.join("backend");

            let data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data_dir).expect("create data dir");

            #[cfg(all(windows, not(target_os = "android")))]
            let job_handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            #[cfg(windows)]
            if !job_handle.is_null() {
                let mut info: JobObjectExtendedLimitInformation = unsafe { std::mem::zeroed() };
                info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                unsafe {
                    SetInformationJobObject(
                        job_handle,
                        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                        &mut info as *mut _ as *mut std::ffi::c_void,
                        std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
                    );
                }
            }
            let state = app.state::<AppState>();
            #[cfg(windows)]
            {
                *state.job.lock().unwrap() = job_handle as usize;
            }

            #[cfg(windows)]
            let node_exe = backend_dir.join("node.exe");
            #[cfg(not(windows))]
            let node_exe = resolve_node(&backend_dir)?;
            let cdp_port = std::env::var("MAGNUM_CDP_PORT").unwrap_or_else(|_| "9222".into());
            let backend_port = std::env::var("MAGNUM_BACKEND_PORT").unwrap_or_else(|_| "5454".into());
            let mut cmd = Command::new(&node_exe);
            cmd.arg("server.js")
                .current_dir(&backend_dir)
                .env("MAGNUM_DATA_DIR", &data_dir)
                .env("MAGNUM_CDP_PORT", &cdp_port)
                .env("MAGNUM_BACKEND_PORT", &backend_port);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            // Own process group so the whole backend tree can be signalled on exit.
            #[cfg(unix)]
            std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
            #[cfg(windows)]
            let child = cmd.spawn().expect("failed to spawn node server");
            #[cfg(not(windows))]
            let child = cmd
                .spawn()
                .map_err(|e| format!("failed to spawn node server ({}): {}", node_exe.display(), e))?;

            #[cfg(windows)]
            if !job_handle.is_null() {
                let pid = child.id();
                let proc_handle = unsafe { OpenProcess(PROCESS_ALL_ACCESS, 0, pid) };
                if !proc_handle.is_null() {
                    unsafe { AssignProcessToJobObject(job_handle, proc_handle) };
                    unsafe { CloseHandle(proc_handle) };
                }
            }

            *state.server.lock().unwrap() = Some(child);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                #[cfg(windows)]
                let pid = {
                    let mut guard = state.server.lock().unwrap();
                    if let Some(child) = guard.as_mut() {
                        let p = child.id();
                        let _ = child.kill();
                        Some(p)
                    } else {
                        None
                    }
                };
                #[cfg(windows)]
                if let Some(p) = pid {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &p.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn();
                }
                #[cfg(unix)]
                if let Some(child) = state.server.lock().unwrap().as_mut() {
                    kill_process_group(child);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, set_app_theme, open_url, read_ws_token, get_backend_port, wait_backend_port, place_embedded_browser, pick_folder, core_selftest])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
