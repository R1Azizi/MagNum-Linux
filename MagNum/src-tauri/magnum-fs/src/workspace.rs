use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_TEXT: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    name: String,
    rel_path: String,
    is_dir: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<FileNode>,
}

/// A private project directory. Imports contain regular files and directories only.
pub struct Workspace(PathBuf);

impl Workspace {
    pub fn open(root: &Path) -> Result<Self, String> {
        if !fs::symlink_metadata(root)
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            return Err("The selected workspace is not a directory.".into());
        }
        Ok(Self(root.canonicalize().map_err(|e| e.to_string())?))
    }

    pub fn resolve(&self, relative: &str) -> Result<PathBuf, String> {
        if relative.is_empty() || relative.contains(['\\', '\0']) {
            return Err("Use a workspace-relative path.".into());
        }
        let mut full = self.0.clone();
        for component in Path::new(relative).components() {
            match component {
                Component::CurDir => (),
                Component::Normal(name) => {
                    full.push(name);
                    match fs::symlink_metadata(&full) {
                        Ok(meta) if !meta.is_file() && !meta.is_dir() => {
                            return Err(format!("Unsupported file type in {relative}."));
                        }
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                            return Err(e.to_string())
                        }
                        _ => (),
                    }
                }
                _ => return Err(format!("Path escapes workspace: {relative}")),
            }
        }
        Ok(full)
    }

    pub fn read(&self, relative: &str) -> Result<String, String> {
        let full = self.resolve(relative)?;
        if !full.is_file() {
            return Err(format!("File not found: {relative}"));
        }
        let mut bytes = Vec::new();
        fs::File::open(full)
            .map_err(|e| e.to_string())?
            .take(MAX_TEXT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_TEXT {
            return Err(format!("{relative} exceeds the 256 KiB text-file limit."));
        }
        if bytes.contains(&0) {
            return Err(format!("{relative} is not a text file."));
        }
        String::from_utf8(bytes).map_err(|_| format!("{relative} is not UTF-8 text."))
    }

    pub fn list(
        &self,
        relative: &str,
        depth: usize,
        limit: usize,
    ) -> Result<(Vec<FileNode>, bool), String> {
        let mut remaining = limit;
        let tree = self.walk(&self.resolve(relative)?, depth, &mut remaining)?;
        Ok((tree, remaining == 0))
    }

    fn walk(
        &self,
        path: &Path,
        depth: usize,
        remaining: &mut usize,
    ) -> Result<Vec<FileNode>, String> {
        let mut entries = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .take(*remaining)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        let mut nodes = Vec::new();
        for entry in entries {
            if *remaining == 0 {
                break;
            }
            *remaining -= 1;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if !kind.is_dir() && !kind.is_file() {
                continue;
            }
            let full = entry.path();
            let rel_path = full.strip_prefix(&self.0).expect("workspace entry");
            let Some(rel_path) = rel_path.to_str() else {
                continue;
            };
            let Some(name) = entry.file_name().into_string().ok() else {
                continue;
            };
            let children = if kind.is_dir() && depth > 1 && name != ".git" {
                self.walk(&full, depth - 1, remaining)?
            } else {
                Vec::new()
            };
            nodes.push(FileNode {
                name,
                rel_path: rel_path.into(),
                is_dir: kind.is_dir(),
                children,
            });
        }
        Ok(nodes)
    }

    pub fn search(&self, query: &str, relative: &str) -> Result<serde_json::Value, String> {
        let (tree, limited) = self.list(relative, 16, 1200)?;
        let mut pending = tree.into_iter().rev().collect::<Vec<_>>();
        let mut matches = Vec::new();
        let mut scanned = 0;
        while let Some(node) = pending.pop() {
            if node.is_dir {
                pending.extend(node.children.into_iter().rev());
                continue;
            }
            if let Ok(text) = self.read(&node.rel_path) {
                scanned += 1;
                for (line, text) in text.lines().enumerate() {
                    if text.contains(query) {
                        matches.push(serde_json::json!({
                            "file": node.rel_path, "line": line + 1,
                            "text": text.chars().take(300).collect::<String>()
                        }));
                        if matches.len() == 40 {
                            return Ok(
                                serde_json::json!({ "matches": matches, "truncated": true }),
                            );
                        }
                    }
                }
            }
            if scanned == 200 {
                return Ok(
                    serde_json::json!({ "matches": matches, "truncated": !pending.is_empty() || limited }),
                );
            }
        }
        Ok(serde_json::json!({ "matches": matches, "truncated": limited }))
    }

    pub fn mutate(&self, mut request: serde_json::Value) -> Result<serde_json::Value, String> {
        request["workspace"] = serde_json::json!(self.0);
        request["allow_outside"] = false.into();
        request["capture_edits"] = true.into();
        request["atomic"] = true.into();
        Ok(super::request(request.to_string().as_bytes()))
    }
}
