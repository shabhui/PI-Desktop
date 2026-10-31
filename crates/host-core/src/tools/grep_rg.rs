//! Optional system `rg` backend for the Grep tool.
//!
//! Codex prefers `rg` when the machine has it. PI-Desktop keeps Grep as the
//! model-facing contract (budgets, newest-first, scoped ignore) and uses a
//! direct `rg` exec as the fast path when a binary is on the user PATH.
//! Spawn failures and `rg` exit 2 fall back to the in-process searcher so a
//! missing or broken install never changes the tool's public shape.

use super::{
    clip_chars, display_tool_path, file_search, grep_output, BUDGET_SEARCH, MAX_LINE_CHARS,
};
use crate::workspace::ToolRoot;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// Cap on `rg --json` stdout so a pathological tree cannot fill host memory
/// before we apply the Grep result budget.
const RG_STDOUT_CAP: usize = 8 * 1024 * 1024;

pub struct SystemGrep<'a> {
    pub pattern: &'a str,
    pub search_dir: &'a Path,
    pub workspace_root: &'a Path,
    /// Root whose `.pi-desktopignore` applies (workspace root, or the search
    /// root for scratch/external searches).
    pub ignore_root: &'a Path,
    pub root_kind: ToolRoot,
    pub scoped: bool,
    pub include: Option<&'a str>,
    pub mode: &'a str,
    pub case_insensitive: bool,
    pub head_limit: usize,
    pub cancellation: &'a file_search::Cancellation,
}

#[cfg(test)]
thread_local! {
    static TEST_RG: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub struct TestRgGuard;

#[cfg(test)]
pub fn current_test_rg() -> Option<PathBuf> {
    TEST_RG.with(|rg| rg.borrow().clone())
}

#[cfg(test)]
pub fn install_test_rg(path: PathBuf) -> TestRgGuard {
    TEST_RG.with(|rg| *rg.borrow_mut() = Some(path));
    TestRgGuard
}

#[cfg(test)]
impl Drop for TestRgGuard {
    fn drop(&mut self) {
        TEST_RG.with(|rg| *rg.borrow_mut() = None);
    }
}

pub fn try_system_rg(req: SystemGrep<'_>) -> Result<Option<Value>, (String, String)> {
    file_search::check(req.cancellation)?;
    let Some(rg) = resolve_rg() else {
        return Ok(None);
    };
    // Called only inside the file tool's blocking body. Tokio owns cancellable
    // pipe I/O and child waiting; no detached reader or waiter thread is needed.
    tokio::runtime::Handle::current().block_on(grep_with_rg(&rg, req))
}

fn resolve_rg() -> Option<PathBuf> {
    #[cfg(test)]
    {
        TEST_RG.with(|rg| rg.borrow().clone())
    }
    #[cfg(not(test))]
    {
        if std::env::var_os("PI_DESKTOP_DISABLE_RG").is_some() {
            return None;
        }
        if let Some(overridden) = std::env::var_os("PI_DESKTOP_RG") {
            let path = PathBuf::from(overridden);
            return path.is_file().then_some(path);
        }
        crate::tools::shell::find_user_program("rg")
    }
}

async fn grep_with_rg(rg: &Path, req: SystemGrep<'_>) -> Result<Option<Value>, (String, String)> {
    let mut args: Vec<String> = vec!["--json".into(), "--no-config".into(), "--hidden".into()];
    // Per-file cap: content never needs more than headLimit hits from one file.
    // count mode needs the real per-file total, so it is left unbounded.
    if req.mode == "filesWithMatches" {
        args.push("--max-count".into());
        args.push("1".into());
    } else if req.mode == "content" {
        // One extra match lets the host set `truncated` the same way the
        // in-process path peeks past headLimit.
        args.push("--max-count".into());
        args.push(req.head_limit.saturating_add(1).to_string());
    }
    if req.case_insensitive {
        args.push("-i".into());
    }
    if req.scoped {
        args.push("--no-ignore-parent".into());
    }
    args.extend(super::ignore_rules::rg_args(req.ignore_root, req.scoped));
    if let Some(include) = req.include {
        args.push("--glob".into());
        args.push(include.to_string());
    }
    args.push("-e".into());
    args.push(req.pattern.to_string());
    args.push("--".into());
    args.push(req.search_dir.to_string_lossy().into_owned());

    file_search::check(req.cancellation)?;
    let Ok(mut child) = Command::new(rg)
        .args(&args)
        // `--ignore-file` patterns are relative to the working directory.
        .current_dir(req.ignore_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return Ok(None);
    };
    #[cfg(test)]
    super::file_search_tests::child_spawned(child.id().unwrap());
    let Some(mut stdout) = child.stdout.take() else {
        stop_owned_child(&mut child).await?;
        return Ok(None);
    };
    let mut cancellation = req.cancellation.clone();
    let mut chunk = [0; file_search::CHUNK_BYTES];
    let mut raw = Vec::new();
    let mut total = 0_usize;
    let mut capped = false;
    let mut failed = false;
    let mut aborted = false;
    let mut parsed: BTreeMap<PathBuf, FileHits> = BTreeMap::new();
    'read: loop {
        #[cfg(test)]
        super::file_search_tests::checkpoint(super::file_search_tests::Stage::RgRead);
        let n = tokio::select! {
            biased;
            _ = file_search::cancelled(&mut cancellation) => {
                aborted = true;
                break;
            }
            result = stdout.read(&mut chunk) => match result {
                Ok(n) => n,
                Err(_) => { failed = true; break; }
            },
        };
        total = total.saturating_add(n);
        if total > RG_STDOUT_CAP {
            capped = true;
            break;
        }
        if n == 0 {
            if let Ok(line) = std::str::from_utf8(&raw) {
                consume_rg_line(line, req.search_dir, &mut parsed);
            } else {
                failed = true;
            }
            break;
        }
        // Unlike read_line, both cancellation and the byte cap apply even
        // when rg is writing an enormous or unterminated JSON event.
        for part in chunk[..n].split_inclusive(|byte| *byte == b'\n') {
            raw.extend_from_slice(part);
            if part.last() == Some(&b'\n') {
                let Ok(line) = std::str::from_utf8(&raw) else {
                    failed = true;
                    break 'read;
                };
                consume_rg_line(line, req.search_dir, &mut parsed);
                raw.clear();
            }
        }
    }
    // Close our pipe before terminating the direct child. No read future or
    // background reader survives this body, including on malformed output.
    drop(stdout);
    let status = if aborted || failed || capped {
        stop_owned_child(&mut child).await?
    } else {
        tokio::select! {
            biased;
            _ = file_search::cancelled(&mut cancellation) => {
                aborted = true;
                stop_owned_child(&mut child).await?
            }
            status = child.wait() => status.map_err(|error| {
                ("TOOL_FAILED".into(), format!("rg wait failed: {error}"))
            })?,
        }
    };
    if aborted {
        return Err(file_search::aborted());
    }
    file_search::check(req.cancellation)?;
    // Preserve the installed-but-broken fallback (0 = matches, 1 = no matches).
    if failed || (!status.success() && status.code() != Some(1)) {
        return Ok(None);
    }
    Ok(Some(build_result(req, parsed, capped)))
}

async fn stop_owned_child(child: &mut Child) -> Result<ExitStatus, (String, String)> {
    if let Err(error) = child.start_kill() {
        // Still wait: a failed kill is not evidence that the child exited and
        // must not release the caller's file lease early.
        tracing::warn!(%error, "failed to stop owned rg child; waiting for exit");
    }
    child
        .wait()
        .await
        .map_err(|error| ("TOOL_FAILED".into(), format!("rg cleanup failed: {error}")))
}

struct FileHits {
    mtime: SystemTime,
    lines: Vec<(usize, String, bool)>,
}

fn consume_rg_line(line: &str, search_dir: &Path, parsed: &mut BTreeMap<PathBuf, FileHits>) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("match") {
        return;
    }
    let data = match value.get("data") {
        Some(data) => data,
        None => return,
    };
    let path_text = data
        .get("path")
        .and_then(|p| p.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if path_text.is_empty() {
        return;
    }
    let mut path = PathBuf::from(path_text);
    if path.is_relative() {
        path = search_dir.join(path);
    }
    // Belt and braces for the security denylist: `.env.*` cannot be expressed
    // as an rg exclude glob without flipping the run into whitelist mode.
    if super::ignore_rules::is_sensitive_path(&path) {
        return;
    }
    let line_no = data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as usize;
    let text = data
        .get("lines")
        .and_then(|l| l.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string();
    let (text, clipped) = clip_chars(text, MAX_LINE_CHARS);
    let mtime = std::fs::metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .unwrap_or(UNIX_EPOCH);
    let entry = parsed.entry(path).or_insert_with(|| FileHits {
        mtime,
        lines: Vec::new(),
    });
    entry.lines.push((line_no, text, clipped));
}

fn build_result(
    req: SystemGrep<'_>,
    parsed: BTreeMap<PathBuf, FileHits>,
    stdout_capped: bool,
) -> Value {
    let mut files: Vec<(PathBuf, FileHits)> = parsed.into_iter().collect();
    files.sort_by(|a, b| b.1.mtime.cmp(&a.1.mtime).then_with(|| a.0.cmp(&b.0)));

    let mut hits: Vec<Value> = Vec::new();
    let mut counts: Vec<Value> = Vec::new();
    let mut matched_files: Vec<String> = Vec::new();
    let mut total_matches = 0_usize;
    let mut clipped_lines = 0_usize;
    let mut bytes = 0_usize;
    let mut truncated = stdout_capped;

    'files: for (path, file) in files {
        let shown = display_tool_path(req.root_kind, req.workspace_root, &path);
        let file_matches = file.lines.len();
        if file_matches == 0 {
            continue;
        }
        match req.mode {
            "content" => {
                for (line_no, text, clipped) in file.lines {
                    if clipped {
                        clipped_lines += 1;
                    }
                    bytes += shown.len() + text.len() + 48;
                    if hits.len() >= req.head_limit || bytes > BUDGET_SEARCH.max_bytes {
                        truncated = true;
                        break 'files;
                    }
                    hits.push(json!({
                        "path": shown,
                        "line": line_no,
                        "text": text,
                    }));
                    total_matches += 1;
                }
                matched_files.push(shown);
            }
            "filesWithMatches" => {
                total_matches += file_matches;
                matched_files.push(shown);
                if matched_files.len() >= req.head_limit {
                    truncated = true;
                    break;
                }
            }
            _ => {
                total_matches += file_matches;
                matched_files.push(shown.clone());
                counts.push(json!({ "path": shown, "count": file_matches }));
                if matched_files.len() >= req.head_limit {
                    truncated = true;
                    break;
                }
            }
        }
    }

    grep_output(
        req.mode,
        hits,
        counts,
        matched_files,
        total_matches,
        clipped_lines,
        truncated,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_match_line_is_clipped_and_crlf_stripped() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let long = format!("needle{}\r\n", "!".repeat(MAX_LINE_CHARS + 8));
        let event = json!({
            "type": "match",
            "data": {
                "path": { "text": file.to_string_lossy() },
                "line_number": 3,
                "lines": { "text": long },
            }
        });
        let mut parsed = BTreeMap::new();
        consume_rg_line(&event.to_string(), dir.path(), &mut parsed);
        let hits = parsed.get(&file).expect("file recorded");
        assert_eq!(hits.lines.len(), 1);
        assert_eq!(hits.lines[0].0, 3);
        assert_eq!(hits.lines[0].1.chars().count(), MAX_LINE_CHARS);
        assert!(hits.lines[0].2);
        assert!(!hits.lines[0].1.contains('\r'));
    }
}
