use crate::addons::ScanData;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const ROOTS: &[&str] = &["models/", "materials/", "sound/", "scripts/", "particles/", "maps/", "resource/", "missions/"];
const EXTENSIONS: &[&str] = &[".mdl", ".vmt", ".vtf", ".wav", ".mp3", ".nut", ".txt", ".pcf", ".bsp", ".res"];
const ERROR_WORDS: &[&str] = &[
    "error", "failed", "missing", "couldn't", "could not", "can't", "cannot", "unable", "mismatch", "not found", "bad ", "invalid",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogIssue {
    pub kind: &'static str,
    pub text: String,
    pub path: Option<String>,
    pub addons: Vec<String>,
    pub count: usize,
    pub last_line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogReport {
    pub path: String,
    pub exists: bool,
    pub modified: u64,
    pub size: u64,
    pub lines: usize,
    pub truncated: bool,
    pub issues: Vec<LogIssue>,
}

pub fn log_path(game_dir: &Path) -> PathBuf {
    game_dir.join("console.log")
}

fn read_tail(path: &Path) -> std::io::Result<(String, u64, bool)> {
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let truncated = size > MAX_BYTES;
    if truncated {
        f.seek(SeekFrom::Start(size - MAX_BYTES))?;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok((String::from_utf8_lossy(&buf).into_owned(), size, truncated))
}

fn extract_paths(line: &str) -> Vec<String> {
    let lower = line.to_ascii_lowercase().replace('\\', "/");
    let mut out = Vec::new();
    for root in ROOTS {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(root) {
            let start = from + pos;
            let boundary = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
            let end = lower[start..]
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ')' | '(' | ']' | '[' | ':' | ';' | '>' | '<'))
                .map(|e| start + e)
                .unwrap_or(lower.len());
            if boundary {
                out.push(lower[start..end].trim_end_matches('.').to_string());
            }
            from = end.max(start + 1);
        }
    }
    let nut = lower.split(|c: char| c.is_whitespace() || matches!(c, '[' | ']' | '"' | '(' | ')')).find(|t| t.ends_with(".nut"));
    if let Some(name) = nut {
        if !name.contains('/') {
            out.push(format!("scripts/vscripts/{name}"));
        }
    }
    out
}

fn candidates(path: &str, line_lower: &str) -> Vec<String> {
    let mut c = vec![path.to_string()];
    for ext in EXTENSIONS {
        c.push(format!("{path}{ext}"));
    }
    if line_lower.contains("material") && !path.starts_with("materials/") {
        c.push(format!("materials/{path}.vmt"));
        c.push(format!("materials/{path}"));
    }
    if line_lower.contains("sound") && !path.starts_with("sound/") {
        c.push(format!("sound/{path}"));
    }
    if path.starts_with("scripts/vscripts/") && !path.ends_with(".nut") {
        c.push(format!("{path}.nut"));
    }
    c
}

fn classify_line(lower: &str) -> Option<&'static str> {
    if lower.contains("host_error") || lower.contains("engine error") || lower.contains("access violation") {
        return Some("crash");
    }
    if lower.contains("an error has occured") || lower.contains("an error has occurred") {
        return Some("script");
    }
    if !ERROR_WORDS.iter().any(|w| lower.contains(w)) {
        return None;
    }
    if lower.contains(".mdl") || lower.contains("model") {
        Some("model")
    } else if lower.contains("material") || lower.contains(".vmt") || lower.contains(".vtf") {
        Some("material")
    } else if lower.contains("sound") || lower.contains(".wav") || lower.contains(".mp3") {
        Some("sound")
    } else {
        Some("error")
    }
}

pub fn analyze(data: &ScanData) -> LogReport {
    let path = log_path(&data.game_dir);
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut report = LogReport {
        path: path.to_string_lossy().into_owned(),
        exists: path.is_file(),
        modified,
        size: 0,
        lines: 0,
        truncated: false,
        issues: Vec::new(),
    };
    let Ok((text, size, truncated)) = read_tail(&path) else { return report };
    report.size = size;
    report.truncated = truncated;

    let mut providers: HashMap<&str, Vec<&str>> = HashMap::new();
    for addon in data.addons.iter().filter(|a| a.enabled) {
        for e in data.files.get(&addon.key).into_iter().flatten() {
            providers.entry(e.path.as_str()).or_default().push(addon.key.as_str());
        }
    }

    let lines: Vec<&str> = text.lines().collect();
    report.lines = lines.len();
    let mut grouped: HashMap<(String, String), LogIssue> = HashMap::new();
    for (n, line) in lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        let Some(kind) = classify_line(&lower) else { continue };
        let mut context = line.trim().to_string();
        let mut found = extract_paths(line);
        if kind == "script" {
            for follow in lines.iter().skip(n + 1).take(12) {
                if follow.trim_start().starts_with("*FUNCTION") {
                    found.extend(extract_paths(follow));
                    context = format!("{} — {}", line.trim(), follow.trim());
                    break;
                }
            }
        }
        let mut hit: Option<(String, Vec<String>)> = None;
        'outer: for p in &found {
            for cand in candidates(p, &lower) {
                if let Some(keys) = providers.get(cand.as_str()) {
                    hit = Some((cand, keys.iter().map(|k| k.to_string()).collect()));
                    break 'outer;
                }
            }
        }
        if hit.is_none() && kind != "crash" && kind != "script" {
            continue;
        }
        let (issue_path, addons) = hit.map(|(p, k)| (Some(p), k)).unwrap_or((found.first().cloned(), Vec::new()));
        let short: String = context.chars().take(400).collect();
        let key = (kind.to_string(), issue_path.clone().unwrap_or_else(|| short.clone()));
        grouped
            .entry(key)
            .and_modify(|i| {
                i.count += 1;
                i.last_line = n + 1;
            })
            .or_insert(LogIssue { kind, text: short, path: issue_path, addons, count: 1, last_line: n + 1 });
    }

    let rank = |k: &str| match k {
        "crash" => 0,
        "script" => 1,
        "model" => 2,
        _ => 3,
    };
    let mut issues: Vec<LogIssue> = grouped.into_values().collect();
    issues.sort_by(|a, b| rank(a.kind).cmp(&rank(b.kind)).then(b.addons.len().min(1).cmp(&a.addons.len().min(1))).then(b.count.cmp(&a.count)));
    report.issues = issues;
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_game_paths() {
        let p = extract_paths(r#"Error loading model "Models\Survivors\Survivor_Coach.mdl" (bad version)"#);
        assert_eq!(p, vec!["models/survivors/survivor_coach.mdl"]);
        let s = extract_paths("*FUNCTION [OnGameEvent_round_start()] left4bots_events.nut line [42]");
        assert_eq!(s, vec!["scripts/vscripts/left4bots_events.nut"]);
    }

    #[test]
    fn material_names_get_materials_prefix() {
        let c = candidates("models/props/gascan", "material models/props/gascan not found");
        assert!(c.contains(&"materials/models/props/gascan.vmt".to_string()));
    }
}
