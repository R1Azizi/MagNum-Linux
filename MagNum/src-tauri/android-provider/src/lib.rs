#![cfg(target_os = "android")]

mod agent;
mod lua_runner;

use serde_json::Value;
use tauri::{
    Manager, Runtime, State,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

#[tauri::command]
async fn provider<R: Runtime>(
    request: Value,
    webview: tauri::Webview<R>,
    handle: State<'_, PluginHandle<R>>,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("Provider chat is available from the main window.".into());
    }
    handle
        .run_mobile_plugin_async("provider", request)
        .await
        .map_err(|_| "The Android provider browser is unavailable.".into())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-provider")
        .setup(|app, api| {
            app.manage(agent::AgentState::default());
            app.manage(api.register_android_plugin("com.green.magnum.provider", "ProviderPlugin")?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![provider, agent::android_agent])
        .build()
}
