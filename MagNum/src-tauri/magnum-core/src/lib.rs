//! magnum-core — shared tool executor for MagNum (desktop + Android).
//!
//! The React UI talks to this crate via the same JSON action protocol used on
//! desktop. Desktop currently proxies to a Node backend; Android runs this
//! crate in-process. Keeping the action surface here is what stops the two
//! platforms from drifting.

use serde::{Deserialize, Serialize};

/// A parsed action coming from the UI over the WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub action: String,
    #[serde(flatten)]
    pub params: serde_json::Value,
}

/// Result sent back to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

impl ActionResult {
    pub fn ok(event: &str, data: serde_json::Value) -> Self {
        Self { event: event.into(), error: None, data }
    }
    pub fn err(event: &str, msg: impl Into<String>) -> Self {
        Self { event: event.into(), error: Some(msg.into()), data: serde_json::Value::Null }
    }
}

/// Abstract browser engine. Desktop implements this over CDP; Android over
/// `android.webkit.WebView` via a Kotlin bridge. Action names match the UI
/// contract exactly: `browse_web`, `read_page`, `embedded_navigate`,
/// `embedded_read_page`.
pub trait BrowserEngine: Send + Sync {
    fn navigate(&self, url: &str) -> Result<String, String>;
    /// Return numbered lines [from, to) — same contract as `read_page`.
    fn read_lines(&self, from: usize, to: usize) -> Result<Vec<String>, String>;
    fn click(&self, selector_or_text: &str) -> Result<(), String>;
    fn fill(&self, selector: &str, value: &str) -> Result<(), String>;
    fn current_url(&self) -> Result<String, String>;
}

/// Abstract filesystem backend. Desktop uses `std::fs`; Android may use an
/// app-scoped dir or the Storage Access Framework (`saf` feature).
pub trait FileSystem: Send + Sync {
    fn read(&self, path: &str) -> Result<String, String>;
    fn write(&self, path: &str, content: &str) -> Result<(), String>;
    fn list(&self, path: &str) -> Result<Vec<String>, String>;
}

/// Tool dispatcher. Routing lives here so both platforms share the same
/// action -> implementation mapping.
pub struct Dispatcher<B: BrowserEngine, F: FileSystem> {
    pub browser: B,
    pub fs: F,
}

impl<B: BrowserEngine, F: FileSystem> Dispatcher<B, F> {
    pub fn dispatch(&self, action: Action) -> ActionResult {
        match action.action.as_str() {
            // File tools
            "read_files" | "read_file" => match self.fs.read(
                action.params.get("file").and_then(|v| v.as_str()).unwrap_or("")
            ) {
                Ok(content) => ActionResult::ok("file_content", serde_json::json!({ "content": content })),
                Err(e) => ActionResult::err("error", e),
            },
            "create_file" => {
                let file = action.params.get("file").and_then(|v| v.as_str()).unwrap_or("");
                let content = action.params.get("content").and_then(|v| v.as_str()).unwrap_or("");
                match self.fs.write(file, content) {
                    Ok(()) => ActionResult::ok("file_patched", serde_json::json!({ "file": file })),
                    Err(e) => ActionResult::err("error", e),
                }
            }
            // Browser tools
            "browse_web" => {
                let url = action.params.get("url").or_else(|| action.params.get("query"))
                    .and_then(|v| v.as_str()).unwrap_or("");
                match self.browser.navigate(url) {
                    Ok(final_url) => ActionResult::ok("embedded_navigate_ack", serde_json::json!({ "url": final_url })),
                    Err(e) => ActionResult::err("error", e),
                }
            }
            "read_page" | "embedded_read_page" => {
                let from = action.params.get("start_line").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
                let to = action.params.get("end_line").and_then(|v| v.as_u64()).unwrap_or(150) as usize;
                match self.browser.read_lines(from, to) {
                    Ok(lines) => ActionResult::ok("embedded_read_ack", serde_json::json!({ "lines": lines })),
                    Err(e) => ActionResult::err("error", e),
                }
            }
            other => ActionResult::err("error", format!("unknown action: {other}")),
        }
    }
}

/// Stub implementations for wiring/testing before real backends land.
pub struct NullBrowser;
impl BrowserEngine for NullBrowser {
    fn navigate(&self, _url: &str) -> Result<String, String> { Err("browser not available".into()) }
    fn read_lines(&self, _f: usize, _t: usize) -> Result<Vec<String>, String> { Ok(vec![]) }
    fn click(&self, _s: &str) -> Result<(), String> { Err("browser not available".into()) }
    fn fill(&self, _s: &str, _v: &str) -> Result<(), String> { Err("browser not available".into()) }
    fn current_url(&self) -> Result<String, String> { Ok(String::new()) }
}

pub struct NullFs;
impl FileSystem for NullFs {
    fn read(&self, _p: &str) -> Result<String, String> { Err("fs not available".into()) }
    fn write(&self, _p: &str, _c: &str) -> Result<(), String> { Err("fs not available".into()) }
    fn list(&self, _p: &str) -> Result<Vec<String>, String> { Ok(vec![]) }
}

pub mod workspace_agent;
