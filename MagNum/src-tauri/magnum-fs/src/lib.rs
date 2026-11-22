// MAGNUM filesystem engine — patch & create, written in Rust.
// Protocol: one JSON request on stdin -> one JSON response on stdout.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

// ---------------- protocol ----------------

#[derive(Debug, Clone, Deserialize)]
struct Patch {
    file: String,
    #[serde(default)]
    search: String,
    #[serde(default)]
    replace: String,
}

#[derive(Debug, Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    workspace: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    search: String,
    #[serde(default)]
    replace: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    patches: Vec<Patch>,
    /// false = reject paths escaping the workspace (../../ etc.)
    #[serde(default)]
    allow_outside: bool,
    #[serde(default)]
    capture_edits: bool,
    #[serde(default)]
    atomic: bool,
}

#[derive(Serialize)]
struct LogLine {
    line: String,
    kind: String,
}

#[derive(Serialize)]
struct AppliedEdit {
    search: String,
    replace: String,
}

#[derive(Serialize)]
struct Detail {
    file: String,
    success: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    edit: Option<AppliedEdit>,
}

#[derive(Serialize, Default)]
struct Response {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    successful: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Vec<Detail>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    created: bool,
    logs: Vec<LogLine>,
}

impl Response {
    fn ok(msg: impl Into<String>) -> Self {
        Self { success: true, message: Some(msg.into()), ..Default::default() }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { success: false, error: Some(msg.into()), ..Default::default() }
    }
    fn log(&mut self, line: impl Into<String>, kind: &str) {
        self.logs.push(LogLine { line: line.into(), kind: kind.to_string() });
    }
}

// ---------------- string helpers (JS parity) ----------------

/// content.replace(/\r\n/g, '\n')
fn lf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// s.replace(/^\n+|\n+$/g, '')
fn trim_edge_newlines(s: &str) -> String {
    s.trim_matches('\n').to_string()
}

/// s.replace(/\u00A0/g,' ').replace(/[ \t]+/g,' ').trim()
fn normalize_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.replace('\u{00A0}', " ").chars() {
        if ch == ' ' || ch == '\t' {
            pending_space = true;
        } else {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// line.replace(/\\\\/g, '\\')  → two backslashes become one
fn collapse_backslashes(s: &str) -> String {
    s.replace("\\\\", "\\")
}

/// line.replace(/^\s*\d+[\s:|]+\s?/, '')
fn strip_line_number(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    let digits_start = i;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start {
        return line.to_string();
    }
    let sep_start = i;
    while i < chars.len() && (chars[i].is_whitespace() || chars[i] == ':' || chars[i] == '|') {
        i += 1;
    }
    if i == sep_start {
        return line.to_string(); // [\s:|]+ needs at least one char
    }
    if i < chars.len() && chars[i].is_whitespace() {
        i += 1; // \s?
    }
    chars[i..].iter().collect()
}

fn strip_numbers(code: &str) -> String {
    code.split('\n').map(strip_line_number).collect::<Vec<_>>().join("\n")
}

/// String.replace(string, string) → FIRST occurrence only.
/// NOTE: unlike JS, `$&` / `$'` in the replacement are treated literally (bug fix).
fn replace_first(hay: &str, needle: &str, rep: &str) -> String {
    match hay.find(needle) {
        Some(i) => {
            let mut out = String::with_capacity(hay.len() + rep.len());
            out.push_str(&hay[..i]);
            out.push_str(rep);
            out.push_str(&hay[i + needle.len()..]);
            out
        }
        None => hay.to_string(),
    }
}

fn leading_ws(s: &str) -> &str {
    &s[..s.len() - s.trim_start().len()]
}

fn io_error(e: &std::io::Error, path: &Path) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("ENOENT: no such file or directory, open '{}'", path.display())
    } else {
        format!("{} ({})", e, path.display())
    }
}

// ---------------- path safety ----------------

/// Lexical normalization, same semantics as Node's path.resolve (no symlink resolution).
fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(c) => out.push(c),
        }
    }
    out
}

fn resolve_target(workspace: &Path, rel: &str, allow_outside: bool) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("Empty file path".into());
    }
    let raw = Path::new(rel);
    let full = if raw.is_absolute() { raw.to_path_buf() } else { workspace.join(raw) };
    let full = normalize_path(&full);
    if !allow_outside {
        let ws = normalize_path(workspace);
        if !full.starts_with(&ws) {
            return Err(format!("Path escapes workspace: {}", rel));
        }
    }
    Ok(full)
}

fn read_text(full: &Path) -> Result<String, String> {
    // Node's readFile(...,'utf-8') is lossy on invalid UTF-8 — keep parity.
    let bytes = fs::read(full).map_err(|e| io_error(&e, full))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn write_text(full: &Path, body: &str, crlf: bool, atomic: bool) -> Result<(), String> {
    let final_body = if crlf { body.replace('\n', "\r\n") } else { body.to_string() };
    write_bytes(full, final_body.as_bytes(), atomic).map_err(|e| io_error(&e, full))
}

fn write_bytes(full: &Path, bytes: &[u8], atomic: bool) -> io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    if !atomic {
        return fs::write(full, bytes);
    }
    loop {
        let temp = full.with_file_name(format!(".magnum-write-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        if temp == full {
            continue;
        }
        let mut file = match fs::OpenOptions::new().create_new(true).write(true).open(&temp) {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            result => result?,
        };
        let result = file.write_all(bytes).and_then(|_| file.sync_all()).and_then(|_| fs::rename(&temp, full));
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        return result;
    }
}

// ---------------- the 4 patch strategies ----------------

fn patch_one(workspace: &Path, p: &Patch, allow_outside: bool) -> (bool, String) {
    patch_one_with_edit(workspace, p, allow_outside, &mut None, false, false)
}

fn patch_one_with_edit(
    workspace: &Path, p: &Patch, allow_outside: bool, edit: &mut Option<AppliedEdit>, capture: bool, atomic: bool,
) -> (bool, String) {
    let full = match resolve_target(workspace, &p.file, allow_outside) {
        Ok(v) => v,
        Err(e) => return (false, e),
    };
    let content = match read_text(&full) {
        Ok(v) => v,
        Err(e) => return (false, e),
    };

    let is_crlf = content.contains("\r\n");
    let normalized = lf(&content);
    let clean_search = trim_edge_newlines(&lf(&p.search));
    let clean_replace = trim_edge_newlines(&lf(&p.replace));

    let mut write_patch = |updated: &str, search: &str, replace: &str, message: String| {
        match write_text(&full, updated, is_crlf, atomic) {
            Ok(_) => {
                if capture && search != replace {
                    *edit = Some(AppliedEdit { search: search.to_owned(), replace: replace.to_owned() });
                }
                (true, message)
            }
            Err(error) => (false, error),
        }
    };

    if atomic {
        let search = lf(&p.search);
        let replace = lf(&p.replace);
        if search.trim().is_empty() || normalized.match_indices(&search).count() != 1 {
            return (false, "Search text must match exactly once. Read the file and retry with a unique snippet.".into());
        }
        let updated = normalized.replacen(&search, &replace, 1);
        if updated.len() > 256 * 1024 {
            return (false, "Patched file exceeds the 256 KiB text-file limit.".into());
        }
        return write_patch(&updated, &search, &replace, format!("Patched {}", p.file));
    }

    // ── Strategy 1: exact substring match ────────────────────────────────
    if normalized.contains(&clean_search) {
        let updated = replace_first(&normalized, &clean_search, &clean_replace);
        return write_patch(&updated, &clean_search, &clean_replace, format!("Successfully updated {}", p.file));
    }

    // ── Strategy 2: model copied the "123 | code" line numbers ───────────
    let no_num_search = strip_numbers(&clean_search);
    let no_num_replace = strip_numbers(&clean_replace);
    if normalized.contains(&no_num_search) {
        let updated = replace_first(&normalized, &no_num_search, &no_num_replace);
        return write_patch(&updated, &no_num_search, &no_num_replace, format!("Successfully updated {}", p.file));
    }

    // ── Strategy 3: fuzzy line-by-line + re-indentation ──────────────────
    let search_lines: Vec<&str> = clean_search.split('\n').collect();
    let mut content_lines: Vec<String> = normalized.split('\n').map(|s| s.to_string()).collect();

    let mut match_index: Option<usize> = None;
    if search_lines.len() <= content_lines.len() {
        'outer: for i in 0..=(content_lines.len() - search_lines.len()) {
            for j in 0..search_lines.len() {
                let c = normalize_spaces(&content_lines[i + j]);
                let s = normalize_spaces(search_lines[j]);
                if c != s && collapse_backslashes(&c) != collapse_backslashes(&s) {
                    continue 'outer;
                }
            }
            match_index = Some(i);
            break;
        }
    }

    if let Some(idx) = match_index {
        let file_base = leading_ws(&content_lines[idx]).to_string();
        let search_base = leading_ws(search_lines[0]).to_string();
        let adjusted: Vec<String> = clean_replace
            .split('\n')
            .map(|line| {
                if line.trim().is_empty() {
                    String::new()
                } else if line.starts_with(&search_base) {
                    format!("{}{}", file_base, &line[search_base.len()..])
                } else {
                    format!("{}{}", file_base, line.trim_start())
                }
            })
            .collect();

        let matched = content_lines[idx..idx + search_lines.len()].join("\n");
        let replacement = adjusted.join("\n");
        content_lines.splice(idx..idx + search_lines.len(), adjusted);
        let updated = content_lines.join("\n");
        return write_patch(&updated, &matched, &replacement, format!("Successfully updated {}", p.file));
    }

    // ── Strategy 4: single-line variable anchor (varName = ...) ──────────
    if search_lines.len() == 1 && search_lines[0].contains('=') {
        let var_prefix = search_lines[0].split('=').next().unwrap_or("").trim();
        let with_space = format!("{} =", var_prefix);
        let without_space = format!("{}=", var_prefix);
        let found = content_lines.iter().position(|l| {
            let n = normalize_spaces(l);
            n.starts_with(&with_space) || n.starts_with(&without_space)
        });
        if let Some(idx) = found {
            let file_base = leading_ws(&content_lines[idx]).to_string();
            let replacement = format!("{}{}", file_base, clean_replace.trim());
            let matched = std::mem::replace(&mut content_lines[idx], replacement);
            let updated = content_lines.join("\n");
            return write_patch(&updated, &matched, &content_lines[idx],
                format!("Successfully updated {} (matched by variable anchor)", p.file));

        }
    }

    (
        false,
        format!(
            "Search block was not found in {}. Check indentation, backslashes, or surrounding code.",
            p.file
        ),
    )
}

// ---------------- batch (dedupe + grouping + duplicate-anchor guard) ----------------

fn patch_batch(workspace: &Path, patches: &[Patch], allow_outside: bool, resp: &mut Response, capture: bool, atomic: bool) {
    // dedupe by file||search||replace, preserving order
    let mut seen: Vec<String> = Vec::new();
    let mut unique: Vec<&Patch> = Vec::new();
    for p in patches {
        let key = format!("{}||{}||{}", p.file, p.search, p.replace);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        unique.push(p);
    }

    // group per file, first-appearance order
    let mut groups: Vec<(String, Vec<&Patch>)> = Vec::new();
    for p in unique {
        match groups.iter_mut().find(|(f, _)| *f == p.file) {
            Some((_, list)) => list.push(p),
            None => groups.push((p.file.clone(), vec![p])),
        }
    }

    let mut details: Vec<Detail> = Vec::new();
    let mut anchors: Vec<(String, Vec<String>)> = Vec::new();

    for (file, list) in groups {
        for p in list {
            let has_anchor = anchors
                .iter()
                .find(|(f, _)| *f == file)
                .map(|(_, set)| set.contains(&p.search))
                .unwrap_or(false);

            if has_anchor && p.replace.contains(&p.search) {
                if let Ok(full) = resolve_target(workspace, &file, allow_outside) {
                    if let Ok(raw) = read_text(&full) {
                        if raw.contains(&p.search) {
                            details.push(Detail {
                                file: file.clone(),
                                success: true,
                                message: "Skipped duplicate patch (anchor still present)".into(),
                                edit: None,
                            });
                            resp.log(format!("skipped duplicate {}", file), "out");
                            continue;
                        }
                    }
                }
            }

            let mut edit = None;
            let (ok, msg) = patch_one_with_edit(workspace, p, allow_outside, &mut edit, capture, atomic);
            if ok {
                resp.log(format!("patched {}", file), "out");
                if p.replace.contains(&p.search) {
                    match anchors.iter_mut().find(|(f, _)| *f == file) {
                        Some((_, set)) => set.push(p.search.clone()),
                        None => anchors.push((file.clone(), vec![p.search.clone()])),
                    }
                }
            } else {
                resp.log(format!("patch failed {}: {}", file, msg), "err");
            }
            details.push(Detail { file: file.clone(), success: ok, message: msg, edit });
        }
    }

    let successful = details.iter().filter(|d| d.success).count();
    resp.total = Some(details.len());
    resp.successful = Some(successful);
    resp.success = details.iter().all(|d| d.success);
    resp.details = Some(details);
}

// ---------------- create file ----------------

fn create_file(workspace: &Path, rel: &str, content: &str, allow_outside: bool, resp: &mut Response, capture: bool, atomic: bool) {
    let full = match resolve_target(workspace, rel, allow_outside) {
        Ok(v) => v,
        Err(e) => {
            resp.success = false;
            resp.error = Some(e);
            return;
        }
    };
    if let Some(parent) = full.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            resp.success = false;
            resp.error = Some(io_error(&e, parent));
            return;
        }
    }
    if capture {
        match fs::metadata(&full) {
            Ok(meta) if meta.is_file() && meta.len() <= 128 * 1024 => {
                resp.previous = fs::read_to_string(&full).ok().filter(|text| !text.contains('\0'));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => resp.created = true,
            _ => {}
        }
    }
    // parity with JS: content is written verbatim (no CRLF rewriting)
    match write_bytes(&full, content.as_bytes(), atomic) {
        Ok(_) => {
            resp.success = true;
            resp.message = Some(format!("Created new file {}", rel));
            resp.log(format!("+ created {}", rel), "out");
        }
        Err(e) => {
            resp.success = false;
            resp.error = Some(io_error(&e, &full));
        }
    }
}

// ---------------- entry point ----------------

fn handle(req: Request) -> Response {
    let mut resp = Response::default();

    if req.op == "ping" {
        return Response::ok("magnum-fs 0.1.0 (rust)");
    }

    let workspace = normalize_path(Path::new(&req.workspace));
    if req.workspace.trim().is_empty() {
        return Response::err("workspace is required");
    }

    match req.op.as_str() {
        "patch_file" => {
            let p = Patch { file: req.file.clone(), search: req.search.clone(), replace: req.replace.clone() };
            let (ok, msg) = patch_one(&workspace, &p, req.allow_outside);
            resp.success = ok;
            if ok {
                resp.message = Some(msg);
            } else {
                resp.error = Some(msg);
            }
        }
        "patch_batch" => patch_batch(&workspace, &req.patches, req.allow_outside, &mut resp, req.capture_edits, req.atomic),
        "create_file" => create_file(&workspace, &req.file, &req.content, req.allow_outside, &mut resp, req.capture_edits, req.atomic),
        other => return Response::err(format!("Unknown op: {}", other)),
    }
    resp
}

/// Run the filesystem protocol in process or from the desktop CLI.
pub fn request(input: &[u8]) -> serde_json::Value {
    let response = match serde_json::from_slice::<Request>(input) {
        Ok(req) => handle(req),
        Err(e) => Response::err(format!("Invalid request JSON: {}", e)),
    };
    serde_json::to_value(response).expect("filesystem response is serializable")
}

pub mod workspace;

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("magnumfs-{}-{}", std::process::id(), rand()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn rand() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos() as u64
    }
    fn p(file: &str, s: &str, r: &str) -> Patch {
        Patch { file: file.into(), search: s.into(), replace: r.into() }
    }

    #[test]
    fn exact_match_first_only() {
        let d = tmp();
        fs::write(d.join("a.txt"), "x\nx\n").unwrap();
        let (ok, _) = patch_one(&d, &p("a.txt", "x", "y"), false);
        assert!(ok);
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "y\nx\n");
    }

    #[test]
    fn strips_line_numbers() {
        let d = tmp();
        fs::write(d.join("a.js"), "const a = 1;\n").unwrap();
        let (ok, _) = patch_one(&d, &p("a.js", "1 | const a = 1;", "1 | const a = 2;"), false);
        assert!(ok);
        assert_eq!(fs::read_to_string(d.join("a.js")).unwrap(), "const a = 2;\n");
    }

    #[test]
    fn fuzzy_reindents() {
        let d = tmp();
        fs::write(d.join("a.js"), "function f() {\n        let a = 1;\n}\n").unwrap();
        let (ok, _) = patch_one(&d, &p("a.js", "  let a = 1;", "  let a = 2;\n  let b = 3;"), false);
        assert!(ok);
        let out = fs::read_to_string(d.join("a.js")).unwrap();
        assert!(out.contains("        let a = 2;\n        let b = 3;"));
    }

    #[test]
    fn variable_anchor() {
        let d = tmp();
        fs::write(d.join("a.js"), "  const port = 3000;\n").unwrap();
        let (ok, msg) = patch_one(&d, &p("a.js", "const port = 9999;", "const port = 4000;"), false);
        assert!(ok, "{msg}");
        assert_eq!(fs::read_to_string(d.join("a.js")).unwrap(), "  const port = 4000;\n");
    }

    #[test]
    fn crlf_preserved() {
        let d = tmp();
        fs::write(d.join("a.txt"), "a\r\nb\r\n").unwrap();
        patch_one(&d, &p("a.txt", "b", "c"), false);
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "a\r\nc\r\n");
    }

    #[test]
    fn create_and_traversal_guard() {
        let d = tmp();
        let mut r = Response::default();
        create_file(&d, "deep/nested/x.js", "hi", false, &mut r, false, false);
        assert!(r.success);
        assert_eq!(fs::read_to_string(d.join("deep/nested/x.js")).unwrap(), "hi");

        let mut r2 = Response::default();
        create_file(&d, "../evil.txt", "x", false, &mut r2, false, false);
        assert!(!r2.success);
    }

    #[test]
    fn batch_dedupe() {
        let d = tmp();
        fs::write(d.join("a.txt"), "one\n").unwrap();
        let patches = vec![p("a.txt", "one", "two"), p("a.txt", "one", "two")];
        let mut r = Response::default();
        patch_batch(&d, &patches, false, &mut r, false, false);
        assert_eq!(r.total, Some(1));
        assert_eq!(r.successful, Some(1));
    }

    #[test]
    fn dollar_patterns_are_literal() {
        let d = tmp();
        fs::write(d.join("a.js"), "A\n").unwrap();
        patch_one(&d, &p("a.js", "A", "$&B"), false);
        assert_eq!(fs::read_to_string(d.join("a.js")).unwrap(), "$&B\n");
    }
}
