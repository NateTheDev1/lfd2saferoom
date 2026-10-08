use crate::{kv, vpk};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Addon {
    pub key: String,
    pub file_name: String,
    pub path: String,
    pub workshop_id: Option<String>,
    pub enabled: bool,
    pub listed: bool,
    pub title: String,
    pub author: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub size: u64,
    pub file_count: usize,
    pub modified: u64,
    pub thumbnail: Option<String>,
    pub error: Option<String>,
}

pub struct ScanData {
    pub game_dir: PathBuf,
    pub addons: Vec<Addon>,
    pub files: HashMap<String, Vec<vpk::Entry>>,
    pub fingerprint: u64,
    pub list_hash: u64,
}

pub fn list_hash(game_dir: &Path) -> u64 {
    let mut h = DefaultHasher::new();
    fs::read(addonlist_path(game_dir)).ok().hash(&mut h);
    h.finish()
}

pub fn fingerprint(game_dir: &Path) -> u64 {
    let mut h = DefaultHasher::new();
    list_hash(game_dir).hash(&mut h);
    let addons = game_dir.join("addons");
    for dir in [addons.clone(), addons.join("workshop")] {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut items: Vec<(String, u64, u64)> = rd
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("vpk")))
            .map(|e| {
                let meta = e.metadata().ok();
                let mtime = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                (e.file_name().to_string_lossy().into_owned(), meta.map(|m| m.len()).unwrap_or(0), mtime)
            })
            .collect();
        items.sort();
        items.hash(&mut h);
    }
    h.finish()
}

pub fn addonlist_path(game_dir: &Path) -> PathBuf {
    game_dir.join("addonlist.txt")
}

pub fn read_addonlist(game_dir: &Path) -> Vec<(String, bool)> {
    let Ok(bytes) = fs::read(addonlist_path(game_dir)) else { return Vec::new() };
    let kv = kv::parse(&kv::decode_text(&bytes));
    kv.get("AddonList")
        .map(|list| {
            list.entries()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().is_some_and(|s| s.trim() != "0")))
                .collect()
        })
        .unwrap_or_default()
}

pub fn render_addonlist(entries: &[(String, bool)]) -> String {
    let mut out = String::from("\"AddonList\"\n{\n");
    for (key, on) in entries {
        out.push_str(&format!("\t\"{}\"\t\t\"{}\"\n", key, if *on { 1 } else { 0 }));
    }
    out.push_str("}\n");
    out
}

pub fn write_addonlist(game_dir: &Path, entries: &[(String, bool)]) -> std::io::Result<()> {
    let target = addonlist_path(game_dir);
    let tmp = target.with_extension("txt.saferoom-tmp");
    fs::write(&tmp, render_addonlist(entries))?;
    fs::rename(&tmp, &target)
}

fn infer_tags(entries: &[vpk::Entry]) -> Vec<String> {
    const RULES: &[(&str, &str)] = &[
        ("maps/", "Map"),
        ("missions/", "Map"),
        ("models/survivors/", "Survivor"),
        ("models/infected/", "Infected"),
        ("models/v_models/", "Weapon"),
        ("models/w_models/", "Weapon"),
        ("models/weapons/", "Weapon"),
        ("scripts/weapon_", "Weapon"),
        ("scripts/vscripts/", "Script"),
        ("sound/music/", "Music"),
        ("sound/", "Sound"),
        ("resource/", "UI"),
        ("materials/vgui/", "UI"),
        ("particles/", "Particles"),
        ("models/", "Model"),
        ("materials/", "Texture"),
    ];
    let mut tags: Vec<&str> = Vec::new();
    for entry in entries {
        if let Some((_, tag)) = RULES.iter().find(|(prefix, _)| entry.path.starts_with(prefix)) {
            if !tags.contains(tag) {
                tags.push(tag);
            }
        }
    }
    tags.sort_by_key(|t| RULES.iter().position(|(_, tag)| tag == t));
    tags.into_iter().map(String::from).collect()
}

struct Found {
    key: String,
    path: PathBuf,
    workshop_id: Option<String>,
}

fn collect_vpks(game_dir: &Path) -> Vec<Found> {
    let addons = game_dir.join("addons");
    let mut found = Vec::new();
    let mut push_dir = |dir: PathBuf, workshop: bool| {
        let Ok(rd) = fs::read_dir(&dir) else { return };
        for entry in rd.flatten() {
            let path = entry.path();
            let is_vpk = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vpk"));
            if !is_vpk || !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let workshop_id = (workshop && stem.chars().all(|c| c.is_ascii_digit())).then(|| stem.clone());
            let key = if workshop { format!("workshop\\{name}") } else { name };
            found.push(Found { key, path, workshop_id });
        }
    };
    push_dir(addons.clone(), false);
    push_dir(addons.join("workshop"), true);
    found
}

pub fn scan(game_dir: &Path) -> Result<ScanData, String> {
    if !game_dir.join("addons").is_dir() {
        return Err(format!("No addons folder in {}", game_dir.display()));
    }
    let list = read_addonlist(game_dir);
    let list_index: HashMap<String, (usize, &str, bool)> = list
        .iter()
        .enumerate()
        .map(|(i, (k, on))| (k.to_ascii_lowercase(), (i, k.as_str(), *on)))
        .collect();

    let parsed: Vec<(Addon, Vec<vpk::Entry>, usize)> = collect_vpks(game_dir)
        .into_par_iter()
        .map(|found| {
            let lookup = list_index.get(&found.key.to_ascii_lowercase());
            let key = lookup.map(|(_, k, _)| k.to_string()).unwrap_or(found.key);
            let meta = fs::metadata(&found.path).ok();
            let file_name = found.path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let thumb = found.path.with_extension("jpg");
            let mut addon = Addon {
                key,
                file_name: file_name.clone(),
                path: found.path.to_string_lossy().into_owned(),
                workshop_id: found.workshop_id,
                enabled: lookup.map(|l| l.2).unwrap_or(true),
                listed: lookup.is_some(),
                title: file_name.trim_end_matches(".vpk").to_string(),
                author: None,
                version: None,
                description: None,
                tags: Vec::new(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                file_count: 0,
                modified: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                thumbnail: thumb.is_file().then(|| thumb.to_string_lossy().into_owned()),
                error: None,
            };
            let entries = match vpk::read(&found.path) {
                Ok(v) => {
                    if let Some(info) = v.addoninfo {
                        let kv = kv::parse(&kv::decode_text(&info));
                        let info = kv.get("AddonInfo").unwrap_or(&kv);
                        let text = |k: &str| info.get_str(k).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
                        if let Some(title) = text("addontitle") {
                            addon.title = title;
                        }
                        addon.author = text("addonauthor");
                        addon.version = text("addonversion");
                        addon.description = text("addondescription");
                    }
                    v.entries
                }
                Err(e) => {
                    addon.error = Some(e.to_string());
                    Vec::new()
                }
            };
            addon.file_count = entries.len();
            addon.tags = infer_tags(&entries);
            let rank = lookup.map(|l| l.0).unwrap_or(usize::MAX);
            (addon, entries, rank)
        })
        .collect();

    let mut parsed = parsed;
    parsed.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.key.to_ascii_lowercase().cmp(&b.0.key.to_ascii_lowercase())));

    let mut addons = Vec::with_capacity(parsed.len());
    let mut files = HashMap::with_capacity(parsed.len());
    for (addon, entries, _) in parsed {
        files.insert(addon.key.clone(), entries);
        addons.push(addon);
    }
    Ok(ScanData {
        game_dir: game_dir.to_path_buf(),
        addons,
        files,
        fingerprint: fingerprint(game_dir),
        list_hash: list_hash(game_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addonlist_round_trips() {
        let entries = vec![("workshop\\123.vpk".to_string(), true), ("mine.vpk".to_string(), false)];
        let text = render_addonlist(&entries);
        assert_eq!(text, "\"AddonList\"\n{\n\t\"workshop\\123.vpk\"\t\t\"1\"\n\t\"mine.vpk\"\t\t\"0\"\n}\n");
        let parsed = kv::parse(&text);
        let list = parsed.get("AddonList").unwrap();
        let back: Vec<(String, bool)> = list.entries().iter().map(|(k, v)| (k.clone(), v.as_str() == Some("1"))).collect();
        assert_eq!(back, entries);
    }
}
