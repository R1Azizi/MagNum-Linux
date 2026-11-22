use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use magnum_core::workspace_agent::Tool;
use magnum_fs::workspace::Workspace;
use mlua::{
    ChunkMode, Error, Function, HookTriggers, Lua, LuaOptions, StdLib, Value, Variadic, VmState,
};
use serde_json::{Value as Json, json};
use tauri::ipc::Channel;

const TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 24 * 1024;

pub const COMMAND_TOOL: Tool = Tool {
    action: "execute_command",
    description: "Run dependency-free Lua 5.4 projects with lua <workspace-relative.lua>. Use assert, print and require for local Lua modules. Commands time out after 20 seconds. No shell, script arguments, network, dependencies or native project toolchains.",
    args: r#"{"command":"lua tests/test.lua"}"#,
};

pub fn run(
    workspace: Arc<Workspace>,
    command: &str,
    cancelled: Arc<AtomicBool>,
    output: Channel<Json>,
) -> Json {
    let logs = Rc::new(RefCell::new(Vec::new()));
    let used = Rc::new(Cell::new(0));
    let truncated = Rc::new(Cell::new(false));
    let output_for_error = output.clone();
    let emit = {
        let logs = logs.clone();
        let used = used.clone();
        let truncated = truncated.clone();
        move |line: &str, is_err: bool| {
            let count = used.get();
            if count >= OUTPUT_LIMIT || logs.borrow().len() >= 400 {
                truncated.set(true);
                return;
            }
            let allowance = (OUTPUT_LIMIT - count).min(4000);
            let mut end = line.len().min(allowance);
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            if end < line.len() {
                truncated.set(true);
            }
            let line = &line[..end];
            used.set(count + line.len() + 1);
            let _ = output.send(json!({ "line": line, "isErr": is_err }));
            logs.borrow_mut().push(line.to_owned());
        }
    };

    let deadline = Instant::now() + TIMEOUT;
    let (exit_code, status, error) = match command.strip_prefix("lua ").filter(|path| {
        path.ends_with(".lua") && !path.contains(['\n', '\r', ';', '|', '&', '<', '>'])
    }) {
        None => (127, "unavailable", Some("Android only bundles Lua 5.4. Use lua <workspace-relative.lua>. The requested shell command or toolchain is unavailable.".into())),
        Some(path) => {
            let result = workspace.read(path)
                .and_then(|text| execute(workspace, path, &text, cancelled.clone(), deadline, emit.clone()).map_err(|err| err.to_string()));
            if cancelled.load(Ordering::Relaxed) {
                (130, "cancelled", Some("Command cancelled.".into()))
            } else if Instant::now() >= deadline {
                (124, "timed_out", Some("Command timed out after 20 seconds.".into()))
            } else if let Err(error) = result {
                (1, "failed", Some(error))
            } else {
                (0, "exited", None)
            }
        }
    };
    if let Some(error) = &error {
        // Always surface failures even after the script exhausts its output allowance.
        let _ = output_for_error.send(json!({ "line": error, "isErr": true }));
    }
    json!({
        "success": exit_code == 0, "exitCode": exit_code, "status": status, "error": error,
        "output": logs.borrow().join("\n"), "outputTruncated": truncated.get()
    })
}

fn execute(
    workspace: Arc<Workspace>,
    path: &str,
    text: &str,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    emit: impl Fn(&str, bool) + 'static,
) -> mlua::Result<()> {
    let lua = Lua::new_with(
        StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8,
        LuaOptions::default(),
    )?;
    lua.set_memory_limit(16 * 1024 * 1024)?;
    lua.set_hook(
        HookTriggers::new().every_nth_instruction(4000),
        move |_, _| {
            if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
                return Err(Error::runtime("Lua command interrupted"));
            }
            Ok(VmState::Continue)
        },
    )?;
    let globals = lua.globals();
    for name in ["dofile", "loadfile", "load", "pcall", "xpcall"] {
        globals.set(name, Value::Nil)?;
    }
    let tostring: Function = globals.get("tostring")?;
    globals.set(
        "print",
        lua.create_function(move |_, args: Variadic<Value>| {
            let mut line = String::new();
            for arg in args {
                if !line.is_empty() {
                    line.push('\t');
                }
                let string: mlua::String = tostring.call(arg)?;
                line.extend(
                    string
                        .to_string_lossy()
                        .chars()
                        .take(4000usize.saturating_sub(line.len())),
                );
                if line.len() >= 4000 {
                    break;
                }
            }
            emit(&line, false);
            Ok(())
        })?,
    )?;

    let modules = lua.create_table()?;
    globals.set(
        "require",
        lua.create_function(move |lua, module: String| {
            if module.len() > 200
                || !module.split('.').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                })
            {
                return Err(Error::runtime(
                    "Use a local Lua module name such as src.math.",
                ));
            }
            let cached: Value = modules.get(module.as_str())?;
            if !cached.is_nil() {
                return Ok(cached);
            }
            let file = format!("{}.lua", module.replace('.', "/"));
            let source = workspace.read(&file).map_err(Error::runtime)?;
            modules.set(module.as_str(), true)?;
            let value: Value = lua
                .load(&source)
                .set_name(format!("@{file}"))
                .set_mode(ChunkMode::Text)
                .call(module.clone())?;
            let value = if value.is_nil() {
                Value::Boolean(true)
            } else {
                value
            };
            modules.set(module.as_str(), value.clone())?;
            Ok(value)
        })?,
    )?;
    lua.load(text)
        .set_name(format!("@{path}"))
        .set_mode(ChunkMode::Text)
        .exec()
}
