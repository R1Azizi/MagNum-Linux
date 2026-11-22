use magnum_fs::workspace::Workspace;
use serde::Serialize;
use serde_json::{json, Value};

use crate::Action;

#[derive(Serialize)]
pub struct Tool {
    pub action: &'static str,
    pub description: &'static str,
    pub args: &'static str,
}

pub const FILE_TOOLS: &[Tool] = &[
    Tool { action: "list_dir", description: "List entries and their workspace-relative paths. Depth is optional (1–5).", args: r#"{"path":".","depth":2}"# },
    Tool { action: "search_code", description: "Search UTF-8 source for a literal string. Path is optional.", args: r#"{"query":"function add","path":"."}"# },
    Tool { action: "read_files", description: "Read up to five UTF-8 files with line numbers. Use read_file for the next range if truncated.", args: r#"{"files":["src/math.lua"]}"# },
    Tool { action: "read_file", description: "Read an inclusive, 1-based line range. Both line fields are optional.", args: r#"{"file":"src/math.lua","start_line":1,"end_line":100}"# },
    Tool { action: "create_file", description: "Create a new text file and any missing parents.", args: r#"{"file":"tests/test.lua","content":"assert(1 + 1 == 2)"}"# },
    Tool { action: "patch_file", description: "Replace exact existing text. Use an unnumbered, unique search snippet from a read. Use an empty replace string to remove text.", args: r#"{"patches":[{"file":"src/math.lua","search":"a - b","replace":"a + b"}]}"# },
];

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params[key]
        .as_str()
        .ok_or_else(|| format!("{key} must be a string."))
}

fn read(
    workspace: &Workspace,
    file: &str,
    from: usize,
    to: usize,
    budget: usize,
) -> Result<Value, String> {
    if from == 0 || to < from {
        return Err("Use valid 1-based line numbers.".into());
    }
    let text = workspace.read(file)?;
    let mut lines = Vec::new();
    let mut remaining = budget;
    let mut next = None;
    for (index, line) in text.lines().enumerate().skip(from - 1) {
        let number = index + 1;
        if number > to || number - from >= 500 || remaining == 0 {
            next = Some(number);
            break;
        }
        // Return the start of exceptionally long lines and mark the result as partial.
        let shown = line.chars().take(remaining).collect::<String>();
        let used = shown.chars().count();
        lines.push(format!("{number}: {shown}"));
        remaining -= used;
        if shown.len() < line.len() {
            return Ok(
                json!({ "file": file, "content": lines.join("\n"), "truncatedLine": number, "nextLine": number + 1 }),
            );
        }
    }
    Ok(json!({ "file": file, "content": lines.join("\n"), "nextLine": next }))
}

pub fn dispatch(workspace: &Workspace, action: Action) -> Result<Value, String> {
    let p = &action.params;
    match action.action.as_str() {
        "list_dir" => {
            let path = p["path"].as_str().unwrap_or(".");
            let depth = p["depth"].as_u64().unwrap_or(2).clamp(1, 5) as usize;
            let (entries, truncated) = workspace.list(path, depth, 120)?;
            Ok(json!({ "entries": entries, "truncated": truncated }))
        }
        "search_code" => {
            let query = required(p, "query")?;
            if query.is_empty() || query.len() > 1024 {
                return Err("Search queries must contain 1–1024 bytes.".into());
            }
            workspace.search(query, p["path"].as_str().unwrap_or("."))
        }
        "read_file" => read(
            workspace,
            required(p, "file")?,
            p["start_line"].as_u64().unwrap_or(1).min(1_000_000) as usize,
            p["end_line"].as_u64().unwrap_or(500).min(1_000_000) as usize,
            10_000,
        ),
        "read_files" => {
            let files = p["files"]
                .as_array()
                .filter(|files| (1..=5).contains(&files.len()))
                .ok_or("files must contain one to five workspace-relative paths.")?;
            let results = files
                .iter()
                .map(|file| {
                    let result = file
                        .as_str()
                        .ok_or_else(|| "Each file must be a string.".into())
                        .and_then(|file| read(workspace, file, 1, 500, 2000));
                    result.unwrap_or_else(|error| json!({ "file": file, "error": error }))
                })
                .collect::<Vec<_>>();
            Ok(json!({ "files": results }))
        }
        "create_file" => {
            let path = required(p, "file")?;
            let content = required(p, "content")?;
            let target = workspace.resolve(path)?;
            if target.exists() {
                return Err("The destination already exists. Use patch_file to edit it.".into());
            }
            if content.len() > 64 * 1024 || content.contains('\0') {
                return Err("New files must be text and at most 64 KiB.".into());
            }
            workspace.mutate(json!({ "op": "create_file", "file": path, "content": content }))
        }
        "patch_file" => {
            let patches = p["patches"]
                .as_array()
                .filter(|patches| (1..=12).contains(&patches.len()))
                .ok_or("patches must contain one to twelve edits.")?;
            for patch in patches {
                let file = required(patch, "file")?;
                let search = required(patch, "search")?;
                let replace = required(patch, "replace")?;
                if search.trim().is_empty()
                    || search.len() + replace.len() > 32 * 1024
                    || replace.contains('\0')
                {
                    return Err(
                        "Each patch needs a nonempty search and at most 32 KiB of text.".into(),
                    );
                }
                workspace.read(file)?;
            }
            workspace.mutate(json!({ "op": "patch_batch", "patches": patches }))
        }
        other => Err(format!("Unsupported Android workspace tool: {other}")),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::symlink,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn workspace_tools_reject_outside_paths_and_write_only_unique_exact_patches() {
        let base = std::env::temp_dir().join(format!(
            "magnum-workspace-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(base.join("outside.lua"), "private content").unwrap();
        symlink(&base, project.join("outside")).unwrap();
        let run = |action: &str, params| {
            dispatch(
                &Workspace::open(&project).unwrap(),
                Action {
                    action: action.into(),
                    params,
                },
            )
        };
        assert!(run("read_file", json!({ "file": "../outside.lua" })).is_err());
        assert!(run("read_file", json!({ "file": "outside/outside.lua" })).is_err());
        assert!(run(
            "create_file",
            json!({ "file": "outside/new.lua", "content": "bad" })
        )
        .is_err());
        assert_eq!(
            run(
                "create_file",
                json!({ "file": "src/math.lua", "content": "old\nold\n" })
            )
            .unwrap()["success"],
            true
        );
        assert_eq!(run("patch_file", json!({ "patches": [{ "file": "src/math.lua", "search": "old", "replace": "new" }] })).unwrap()["success"], false);
        assert_eq!(
            fs::read_to_string(project.join("src/math.lua")).unwrap(),
            "old\nold\n"
        );
        assert_eq!(run("patch_file", json!({ "patches": [{ "file": "src/math.lua", "search": "old\nold", "replace": "new" }] })).unwrap()["success"], true);
        assert_eq!(
            fs::read_to_string(project.join("src/math.lua")).unwrap(),
            "new\n"
        );
        assert!(!base.join("new.lua").exists());
        fs::remove_dir_all(base).unwrap();
    }
}
