use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use magnum_core::{
    Action,
    workspace_agent::{self, FILE_TOOLS},
};
use magnum_fs::workspace::Workspace;
use serde_json::{Value, json};
use tauri::{Manager, Runtime, State, ipc::Channel, plugin::PluginHandle};

use crate::lua_runner;

#[derive(Clone)]
struct Run {
    id: String,
    workspace: Arc<Workspace>,
    cancelled: Arc<AtomicBool>,
    dispatch: Arc<Mutex<()>>,
}

#[derive(Default)]
pub struct AgentState(Mutex<Option<Run>>);

fn select(root: &Path, path: &str) -> Result<Workspace, String> {
    let path = Path::new(path);
    if path.parent() != Some(root)
        || path
            .file_name()
            .is_none_or(|name| name.to_string_lossy().starts_with('.'))
    {
        return Err("Select an app-owned workspace first.".into());
    }
    Workspace::open(path)
}

fn current(state: &AgentState, id: &str) -> Result<Run, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|run| run.id == id)
        .cloned()
        .ok_or_else(|| "The Android run has ended.".into())
}

#[tauri::command]
pub async fn android_agent<R: Runtime>(
    request: Action,
    output: Channel<Value>,
    webview: tauri::Webview<R>,
    mobile: State<'_, PluginHandle<R>>,
    state: State<'_, AgentState>,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("Android agent tools are available from the main window.".into());
    }
    let field = |key: &str| request.params[key].as_str().unwrap_or("");
    let root = webview
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("files")
        .join("agent-workspaces");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    match request.action.as_str() {
        "capabilities" => Ok(json!({
            "tools": FILE_TOOLS.iter().chain([&lua_runner::COMMAND_TOOL]).collect::<Vec<_>>(),
        })),
        "import" => {
            let result: Value = mobile
                .run_mobile_plugin_async("importWorkspace", json!({}))
                .await
                .map_err(|e| e.to_string())?;
            if let Some(path) = result["path"].as_str() {
                select(&root, path)?;
            }
            Ok(result)
        }
        "browse" => mobile
            .run_mobile_plugin_async("browseWorkspaces", json!({}))
            .await
            .map_err(|e| e.to_string()),
        "create" => {
            let name = field("name").trim();
            if name.is_empty()
                || name.len() > 80
                || name.starts_with('.')
                || !name
                    .chars()
                    .all(|c| c.is_alphanumeric() || " _.-".contains(c))
            {
                return Err("Use 1–80 bytes of letters, numbers, spaces, dots, underscores or hyphens. Start with a letter or number.".into());
            }
            let path = root.join(name);
            fs::create_dir(&path).map_err(|e| format!("Could not create {name}: {e}"))?;
            Ok(json!({ "path": path }))
        }
        "workspaces" => {
            let mut paths = fs::read_dir(root)
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.file_type().is_ok_and(|kind| kind.is_dir())
                        && !entry.file_name().to_string_lossy().starts_with('.')
                })
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            paths.sort();
            Ok(json!({ "paths": paths }))
        }
        "inspect" => {
            let workspace = select(&root, field("path"))?;
            let file = field("file").to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                if file.is_empty() {
                    let (tree, _) = workspace.list(".", 10, 800)?;
                    Ok(json!({ "tree": tree }))
                } else {
                    Ok(json!({ "content": workspace.read(&file)? }))
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "begin" => {
            let id = field("runId");
            if id.is_empty() {
                return Err("A run ID is required.".into());
            }
            let workspace = select(&root, field("path"))?;
            let mut slot = state.0.lock().map_err(|e| e.to_string())?;
            if slot.is_some() {
                return Err("An Android workspace run is already active.".into());
            }
            *slot = Some(Run {
                id: id.into(),
                workspace: Arc::new(workspace),
                cancelled: Arc::default(),
                dispatch: Arc::default(),
            });
            Ok(json!({}))
        }
        "stop" => {
            if let Ok(run) = current(&state, field("runId")) {
                run.cancelled.store(true, Ordering::Relaxed);
            }
            Ok(json!({}))
        }
        "end" => {
            let mut slot = state.0.lock().map_err(|e| e.to_string())?;
            if slot.as_ref().is_some_and(|run| run.id == field("runId")) {
                if let Some(run) = slot.take() {
                    run.cancelled.store(true, Ordering::Relaxed);
                }
            }
            Ok(json!({}))
        }
        "tool" => {
            let run = current(&state, field("runId"))?;
            let action: Action = serde_json::from_value(request.params["tool"].clone())
                .map_err(|e| e.to_string())?;
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = run
                    .dispatch
                    .try_lock()
                    .map_err(|_| "An Android workspace tool is already running.")?;
                if run.cancelled.load(Ordering::Relaxed) {
                    return Err("The Android run was stopped.".into());
                }
                if action.action == lua_runner::COMMAND_TOOL.action {
                    let command = action.params["command"]
                        .as_str()
                        .ok_or("command must be a string.")?;
                    Ok(lua_runner::run(
                        run.workspace,
                        command,
                        run.cancelled,
                        output,
                    ))
                } else {
                    workspace_agent::dispatch(&run.workspace, action)
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        _ => Err("Unknown Android agent operation.".into()),
    }
}
