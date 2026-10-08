pub mod addons;
pub mod analysis;
pub mod arrange;
pub mod consolelog;
pub mod kv;
pub mod steam;
pub mod vpk;
pub mod workshop;

use addons::{Addon, ScanData};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Builder, Manager, Runtime, State};

const MAX_BACKUPS: usize = 40;
const MAX_LOG_ARCHIVES: usize = 10;
pub const STALE_PREFIX: &str = "STALE:";

type AssetAllower = Box<dyn Fn(&Path) + Send + Sync>;

struct AppState {
    scan: Arc<Mutex<Option<ScanData>>>,
    data_dir: OnceLock<PathBuf>,
    check_game: bool,
    allow_assets: OnceLock<AssetAllower>,
}

impl AppState {
    fn data_dir(&self) -> Result<&PathBuf, String> {
        self.data_dir.get().ok_or_else(|| "App is still starting".to_string())
    }
}

#[derive(Default)]
pub struct Config {
    pub data_dir: Option<PathBuf>,
    pub skip_game_check: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    game_dir: String,
    addons: Vec<Addon>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    game_running: bool,
    external_change: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    name: String,
    created: u64,
    entries: usize,
    enabled: usize,
}

fn millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn subdir(state: &AppState, name: &str) -> Result<PathBuf, String> {
    let dir = state.data_dir()?.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn game_dir(state: &AppState) -> Result<PathBuf, String> {
    let guard = state.scan.lock().map_err(|e| e.to_string())?;
    guard.as_ref().map(|d| d.game_dir.clone()).ok_or_else(|| "Scan the game folder first".into())
}

fn ensure_game_closed(state: &AppState) -> Result<(), String> {
    if state.check_game && steam::game_running() {
        return Err("Left 4 Dead 2 is running. Close the game first, it rewrites addonlist.txt on exit.".into());
    }
    Ok(())
}

fn prune(dir: &Path, prefix: &str, keep: usize) -> Result<(), String> {
    let mut existing: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(prefix))
        .collect();
    existing.sort();
    let excess = existing.len().saturating_sub(keep);
    for old in &existing[..excess] {
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(())
}

fn backup_current(state: &AppState, game_dir: &Path) -> Result<Option<String>, String> {
    let src = addons::addonlist_path(game_dir);
    if !src.is_file() {
        return Ok(None);
    }
    let dir = subdir(state, "backups")?;
    let name = format!("addonlist-{}.txt", millis());
    std::fs::copy(&src, dir.join(&name)).map_err(|e| e.to_string())?;
    prune(&dir, "addonlist-", MAX_BACKUPS)?;
    Ok(Some(name))
}

#[tauri::command]
fn locate_game() -> Option<String> {
    steam::find_game_dir().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn scan(state: State<'_, AppState>, game_dir: Option<String>) -> Result<ScanResult, String> {
    let dir = match game_dir {
        Some(d) => steam::normalize_game_dir(Path::new(&d)).ok_or_else(|| format!("{d} doesn't look like a Left 4 Dead 2 folder"))?,
        None => steam::find_game_dir().ok_or("Couldn't find Left 4 Dead 2 in any Steam library")?,
    };
    let scan_dir = dir.clone();
    let data = tauri::async_runtime::spawn_blocking(move || addons::scan(&scan_dir))
        .await
        .map_err(|e| e.to_string())??;
    if let Some(allow) = state.allow_assets.get() {
        allow(&dir.join("addons"));
    }
    let result = ScanResult { game_dir: dir.to_string_lossy().into_owned(), addons: data.addons.clone() };
    *state.scan.lock().map_err(|e| e.to_string())? = Some(data);
    Ok(result)
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> Result<Status, String> {
    let shared = state.scan.clone();
    let check_game = state.check_game;
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = shared.lock().map_err(|e| e.to_string())?.as_ref().map(|d| (d.game_dir.clone(), d.fingerprint));
        let external_change = snapshot.is_some_and(|(dir, fp)| addons::fingerprint(&dir) != fp);
        Ok(Status { game_running: check_game && steam::game_running(), external_change })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn analyze(state: State<'_, AppState>, order: Vec<String>, enabled: Vec<String>) -> Result<analysis::Analysis, String> {
    let shared = state.scan.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = shared.lock().map_err(|e| e.to_string())?;
        let data = guard.as_ref().ok_or("Not scanned yet")?;
        let enabled: HashSet<String> = enabled.into_iter().collect();
        Ok(analysis::analyze(data, &order, &enabled))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn arrange(
    state: State<'_, AppState>,
    order: Vec<String>,
    enabled: Vec<String>,
    rules: Vec<arrange::Rule>,
    options: arrange::Options,
) -> Result<arrange::Plan, String> {
    let shared = state.scan.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = shared.lock().map_err(|e| e.to_string())?;
        let data = guard.as_ref().ok_or("Not scanned yet")?;
        let enabled: HashSet<String> = enabled.into_iter().collect();
        Ok(arrange::plan(data, &order, &enabled, &rules, options))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn addon_files(state: State<'_, AppState>, key: String) -> Result<Vec<String>, String> {
    let guard = state.scan.lock().map_err(|e| e.to_string())?;
    let data = guard.as_ref().ok_or("Not scanned yet")?;
    let mut files: Vec<String> = data.files.get(&key).map(|e| e.iter().map(|f| f.path.clone()).collect()).unwrap_or_default();
    files.sort();
    Ok(files)
}

#[tauri::command]
fn save_addonlist(state: State<'_, AppState>, order: Vec<String>, enabled: Vec<String>, force: Option<bool>) -> Result<Option<String>, String> {
    ensure_game_closed(&state)?;
    let (dir, known, scanned_hash) = {
        let guard = state.scan.lock().map_err(|e| e.to_string())?;
        let data = guard.as_ref().ok_or("Scan the game folder first")?;
        let known: Vec<(String, bool)> = data.addons.iter().map(|a| (a.key.clone(), a.enabled)).collect();
        (data.game_dir.clone(), known, data.list_hash)
    };
    if !force.unwrap_or(false) && addons::list_hash(&dir) != scanned_hash {
        return Err(format!("{STALE_PREFIX} addonlist.txt was changed outside Saferoom (by the game or Steam) since the last scan."));
    }
    let enabled: HashSet<&str> = enabled.iter().map(String::as_str).collect();
    let known_keys: HashSet<&str> = known.iter().map(|(k, _)| k.as_str()).collect();

    let mut seen = HashSet::new();
    let mut entries: Vec<(String, bool)> = order
        .iter()
        .filter(|k| known_keys.contains(k.as_str()) && seen.insert(k.as_str()))
        .map(|k| (k.clone(), enabled.contains(k.as_str())))
        .collect();
    for (k, on) in &known {
        if !seen.contains(k.as_str()) {
            entries.push((k.clone(), *on));
        }
    }

    let backup = backup_current(&state, &dir)?;
    addons::write_addonlist(&dir, &entries).map_err(|e| format!("Couldn't write addonlist.txt: {e}"))?;

    let mut guard = state.scan.lock().map_err(|e| e.to_string())?;
    if let Some(data) = guard.as_mut() {
        let index: HashMap<&str, (usize, bool)> = entries.iter().enumerate().map(|(i, (k, on))| (k.as_str(), (i, *on))).collect();
        for a in &mut data.addons {
            if let Some((_, on)) = index.get(a.key.as_str()) {
                a.enabled = *on;
                a.listed = true;
            }
        }
        data.addons.sort_by_key(|a| index.get(a.key.as_str()).map(|v| v.0).unwrap_or(usize::MAX));
        data.list_hash = addons::list_hash(&dir);
        data.fingerprint = addons::fingerprint(&dir);
    }
    Ok(backup)
}

#[tauri::command]
fn launch_game(condebug: Option<bool>) -> Result<(), String> {
    let url = if condebug.unwrap_or(false) {
        format!("steam://run/{}//-condebug/", steam::APP_ID)
    } else {
        format!("steam://rungameid/{}", steam::APP_ID)
    };
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_backups(state: State<'_, AppState>) -> Result<Vec<Backup>, String> {
    let dir = subdir(&state, "backups")?;
    let mut out: Vec<Backup> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let created: u64 = name.strip_prefix("addonlist-")?.strip_suffix(".txt")?.parse().ok()?;
            let text = std::fs::read(e.path()).ok()?;
            let parsed = kv::parse(&kv::decode_text(&text));
            let list = parsed.get("AddonList");
            let entries = list.map(|l| l.entries().len()).unwrap_or(0);
            let enabled = list
                .map(|l| l.entries().iter().filter(|(_, v)| v.as_str().is_some_and(|s| s.trim() != "0")).count())
                .unwrap_or(0);
            Some(Backup { name, created, entries, enabled })
        })
        .collect();
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

#[tauri::command]
fn restore_backup(state: State<'_, AppState>, name: String) -> Result<(), String> {
    ensure_game_closed(&state)?;
    if name.contains(['/', '\\']) || !name.starts_with("addonlist-") {
        return Err("Invalid backup name".into());
    }
    let dir = game_dir(&state)?;
    let text = std::fs::read(subdir(&state, "backups")?.join(&name)).map_err(|e| e.to_string())?;
    backup_current(&state, &dir)?;
    std::fs::write(addons::addonlist_path(&dir), text).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workshop_details(state: State<'_, AppState>, ids: Vec<String>) -> Result<HashMap<String, workshop::WorkshopInfo>, String> {
    let cache = state.data_dir()?.join("workshop-cache.json");
    workshop::details(&cache, ids).await
}

#[tauri::command]
async fn workshop_requirements(state: State<'_, AppState>, ids: Vec<String>) -> Result<workshop::RequirementBatch, String> {
    let cache = state.data_dir()?.join("requirements-cache.json");
    workshop::requirements(&cache, ids).await
}

#[tauri::command]
async fn read_console_log(state: State<'_, AppState>) -> Result<consolelog::LogReport, String> {
    let shared = state.scan.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = shared.lock().map_err(|e| e.to_string())?;
        let data = guard.as_ref().ok_or("Not scanned yet")?;
        Ok(consolelog::analyze(data))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn archive_console_log(state: State<'_, AppState>) -> Result<(), String> {
    ensure_game_closed(&state)?;
    let src = consolelog::log_path(&game_dir(&state)?);
    if !src.is_file() {
        return Ok(());
    }
    let dir = subdir(&state, "logs")?;
    let target = dir.join(format!("console-{}.log", millis()));
    std::fs::copy(&src, &target).map_err(|e| e.to_string())?;
    std::fs::remove_file(&src).map_err(|e| e.to_string())?;
    prune(&dir, "console-", MAX_LOG_ARCHIVES)
}

fn store_path(state: &AppState, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid store name".into());
    }
    let dir = state.data_dir()?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")))
}

#[tauri::command]
fn store_get(state: State<'_, AppState>, name: String) -> Result<Option<serde_json::Value>, String> {
    match std::fs::read(store_path(&state, &name)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn store_set(state: State<'_, AppState>, name: String, value: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(store_path(&state, &name)?, json).map_err(|e| e.to_string())
}

const MAX_CONFIG_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
fn machine_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this PC".into())
}

#[tauri::command]
fn export_config(path: String, config: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Couldn't write {path}: {e}"))
}

#[tauri::command]
fn import_config(path: String) -> Result<serde_json::Value, String> {
    let size = std::fs::metadata(&path).map_err(|e| format!("Couldn't open {path}: {e}"))?.len();
    if size > MAX_CONFIG_BYTES {
        return Err("That file is too large to be a Saferoom configuration".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "That file isn't valid JSON".to_string())?;
    if value.get("format").and_then(|f| f.as_str()) != Some("saferoom-config") {
        return Err("That file isn't a Saferoom configuration export".into());
    }
    Ok(value)
}

pub fn configure<R: Runtime>(builder: Builder<R>, config: Config) -> Builder<R> {
    let state = AppState {
        scan: Arc::default(),
        data_dir: OnceLock::new(),
        check_game: !config.skip_game_check,
        allow_assets: OnceLock::new(),
    };
    if let Some(dir) = config.data_dir {
        let _ = state.data_dir.set(dir);
    }
    builder
        .manage(state)
        .setup(|app| {
            let state = app.state::<AppState>();
            if state.data_dir.get().is_none() {
                let _ = state.data_dir.set(app.path().app_data_dir()?);
            }
            let handle = app.handle().clone();
            let _ = state.allow_assets.set(Box::new(move |dir| {
                let _ = handle.asset_protocol_scope().allow_directory(dir, true);
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            locate_game,
            scan,
            status,
            analyze,
            arrange,
            addon_files,
            save_addonlist,
            launch_game,
            reveal,
            list_backups,
            restore_backup,
            workshop_details,
            workshop_requirements,
            read_console_log,
            archive_console_log,
            store_get,
            store_set,
            machine_name,
            export_config,
            import_config,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    configure(builder, Config::default())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
