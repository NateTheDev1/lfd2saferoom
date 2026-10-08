use crate::addons::ScanData;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Harmless,
    Low,
    Medium,
    High,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub category: &'static str,
    pub severity: Severity,
    pub identical: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub winner: String,
    pub loser: String,
    pub severity: Severity,
    pub total: usize,
    pub identical: usize,
    pub categories: BTreeMap<&'static str, usize>,
    pub files: Vec<ConflictFile>,
    pub truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SplitPart {
    pub file: String,
    pub winner: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SplitModel {
    pub model: String,
    pub severity: Severity,
    pub addons: Vec<String>,
    pub parts: Vec<SplitPart>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AddonStats {
    pub files: usize,
    pub wins: usize,
    pub losses: usize,
    pub identical_losses: usize,
    pub shadowed: bool,
    pub split_models: usize,
    pub worst: Option<Severity>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Duplicate {
    pub a: String,
    pub b: String,
    pub shared: usize,
    pub ratio: f32,
    pub same_title: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub pairs: Vec<Pair>,
    pub split_models: Vec<SplitModel>,
    pub duplicates: Vec<Duplicate>,
    pub stats: HashMap<String, AddonStats>,
}

const MAX_FILES_PER_PAIR: usize = 400;

const MODEL_PARTS: &[&str] = &[".dx90.vtx", ".dx80.vtx", ".sw.vtx", ".vtx", ".mdl", ".vvd", ".phy", ".ani"];

const SHARED_ADDON_SCRIPTS: &[&str] = &[
    "scripts/vscripts/mapspawn_addon.nut",
    "scripts/vscripts/scriptedmode_addon.nut",
    "scripts/vscripts/director_base_addon.nut",
    "scripts/vscripts/response_testbed_addon.nut",
];

pub fn classify(path: &str) -> Option<(&'static str, Severity)> {
    if !path.contains('/') || SHARED_ADDON_SCRIPTS.contains(&path) {
        return None;
    }
    let rules: &[(&str, &'static str, Severity)] = &[
        ("scripts/vscripts/", "vscript", Severity::High),
        ("scripts/talker/", "talker", Severity::High),
        ("scripts/", "script", Severity::High),
        ("missions/", "mission", Severity::High),
        ("maps/", "map", Severity::High),
        ("resource/", "ui", Severity::Medium),
        ("particles/", "particle", Severity::Medium),
        ("models/", "model", Severity::Medium),
        ("materials/", "material", Severity::Low),
        ("sound/", "sound", Severity::Low),
    ];
    let found = rules.iter().find(|(prefix, _, _)| path.starts_with(prefix));
    Some(found.map(|(_, c, s)| (*c, *s)).unwrap_or(("other", Severity::Low)))
}

pub(crate) const CORE_PARTS: &[&str] = &[".dx90.vtx", ".dx80.vtx", ".sw.vtx", ".vtx", ".mdl", ".vvd"];

pub(crate) fn is_core_part(path: &str) -> bool {
    CORE_PARTS.iter().any(|s| path.ends_with(s))
}

pub(crate) fn model_stem(path: &str) -> Option<(&str, &'static str)> {
    if !path.starts_with("models/") {
        return None;
    }
    MODEL_PARTS
        .iter()
        .find(|suffix| path.ends_with(*suffix))
        .map(|suffix| (&path[..path.len() - suffix.len()], *suffix))
}

struct Provider {
    rank: usize,
    crc: u32,
    len: u32,
}

pub fn analyze(data: &ScanData, order: &[String], enabled: &HashSet<String>) -> Analysis {
    let active: Vec<&String> = order
        .iter()
        .filter(|k| enabled.contains(*k) && data.files.contains_key(*k))
        .collect();

    let mut providers: HashMap<&str, Vec<Provider>> = HashMap::new();
    let mut stats: HashMap<String, AddonStats> = HashMap::new();
    for (rank, key) in active.iter().enumerate() {
        let mut counted = 0;
        for e in &data.files[*key] {
            if classify(&e.path).is_none() {
                continue;
            }
            counted += 1;
            providers.entry(e.path.as_str()).or_default().push(Provider { rank, crc: e.crc, len: e.len });
        }
        stats.insert((*key).clone(), AddonStats { files: counted, ..Default::default() });
    }

    let mut pairs: HashMap<(usize, usize), Pair> = HashMap::new();
    let mut model_groups: HashMap<&str, Vec<(&str, usize)>> = HashMap::new();

    for (path, provs) in &providers {
        if let Some((stem, _)) = model_stem(path) {
            model_groups.entry(stem).or_default().push((path, provs[0].rank));
        }
        if provs.len() < 2 {
            continue;
        }
        let (category, severity) = classify(path).expect("classified on insert");
        let winner = &provs[0];
        for loser in &provs[1..] {
            let identical = loser.crc == winner.crc && loser.len == winner.len;
            let pair = pairs.entry((winner.rank, loser.rank)).or_insert_with(|| Pair {
                winner: active[winner.rank].clone(),
                loser: active[loser.rank].clone(),
                severity: Severity::Harmless,
                total: 0,
                identical: 0,
                categories: BTreeMap::new(),
                files: Vec::new(),
                truncated: false,
            });
            pair.total += 1;
            if identical {
                pair.identical += 1;
            } else {
                pair.severity = pair.severity.max(severity);
                *pair.categories.entry(category).or_default() += 1;
            }
            pair.files.push(ConflictFile {
                path: (*path).to_string(),
                category,
                severity: if identical { Severity::Harmless } else { severity },
                identical,
            });

            let w = stats.get_mut(active[winner.rank]).expect("stats");
            if !identical {
                w.wins += 1;
            }
            let l = stats.get_mut(active[loser.rank]).expect("stats");
            if identical {
                l.identical_losses += 1;
            } else {
                l.losses += 1;
            }
        }
    }

    let mut split_models = Vec::new();
    for (stem, mut parts) in model_groups {
        parts.retain(|(p, _)| !p.ends_with(".ani"));
        parts.sort();
        let winners_where = |pred: &dyn Fn(&str) -> bool| parts.iter().filter(|(p, _)| pred(p)).map(|(_, r)| *r).collect::<HashSet<_>>();
        let core = winners_where(&|p| is_core_part(p));
        let phy = winners_where(&|p| p.ends_with(".phy"));
        let severity = if core.len() > 1 {
            Severity::High
        } else if !core.is_empty() && !phy.is_empty() && phy != core {
            Severity::Low
        } else {
            continue;
        };
        let mut ranks: Vec<usize> = parts.iter().map(|(_, r)| *r).collect::<HashSet<_>>().into_iter().collect();
        ranks.sort();
        for r in &ranks {
            let s = stats.get_mut(active[*r]).expect("stats");
            if severity == Severity::High {
                s.split_models += 1;
            }
            s.worst = s.worst.max(Some(severity));
        }
        split_models.push(SplitModel {
            model: stem.to_string(),
            severity,
            addons: ranks.iter().map(|r| active[*r].clone()).collect(),
            parts: parts
                .iter()
                .map(|(p, r)| SplitPart { file: (*p).to_string(), winner: active[*r].clone() })
                .collect(),
        });
    }
    split_models.sort_by(|a, b| b.severity.cmp(&a.severity).then_with(|| a.model.cmp(&b.model)));

    let mut pairs: Vec<Pair> = pairs.into_values().collect();
    for pair in &mut pairs {
        pair.files.sort_by(|a, b| a.identical.cmp(&b.identical).then(b.severity.cmp(&a.severity)).then_with(|| a.path.cmp(&b.path)));
        if pair.files.len() > MAX_FILES_PER_PAIR {
            pair.files.truncate(MAX_FILES_PER_PAIR);
            pair.truncated = true;
        }
        for key in [&pair.winner, &pair.loser] {
            let s = stats.get_mut(key).expect("stats");
            s.worst = s.worst.max(Some(pair.severity));
        }
    }
    pairs.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then((b.total - b.identical).cmp(&(a.total - a.identical)))
            .then_with(|| a.winner.cmp(&b.winner))
    });

    for s in stats.values_mut() {
        s.shadowed = s.files > 0 && s.losses + s.identical_losses == s.files;
    }

    let duplicates = find_duplicates(data, &active, &providers, &stats);
    Analysis { pairs, split_models, duplicates, stats }
}

fn normalize_title(title: &str) -> String {
    title.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn similar_titles(a: &str, b: &str) -> bool {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    short.len() >= 4 && long.starts_with(short) && long.len() - short.len() <= 3
}

fn find_duplicates(
    data: &ScanData,
    active: &[&String],
    providers: &HashMap<&str, Vec<Provider>>,
    stats: &HashMap<String, AddonStats>,
) -> Vec<Duplicate> {
    let mut overlap: HashMap<(usize, usize), usize> = HashMap::new();
    for provs in providers.values() {
        if provs.len() < 2 || provs.len() > 16 {
            continue;
        }
        for i in 0..provs.len() {
            for j in i + 1..provs.len() {
                *overlap.entry((provs[i].rank, provs[j].rank)).or_default() += 1;
            }
        }
    }
    let titles: HashMap<&str, String> = data.addons.iter().map(|a| (a.key.as_str(), normalize_title(&a.title))).collect();
    let mut out: Vec<Duplicate> = overlap
        .into_iter()
        .filter_map(|((a, b), shared)| {
            let (ka, kb) = (active[a], active[b]);
            let union = (stats[ka].files + stats[kb].files).saturating_sub(shared).max(1);
            let ratio = shared as f32 / union as f32;
            let same_title = match (titles.get(ka.as_str()), titles.get(kb.as_str())) {
                (Some(x), Some(y)) => similar_titles(x, y),
                _ => false,
            };
            ((ratio >= 0.6 && shared >= 3) || same_title).then(|| Duplicate { a: ka.clone(), b: kb.clone(), shared, ratio, same_title })
        })
        .collect();
    out.sort_by(|x, y| y.same_title.cmp(&x.same_title).then(y.ratio.total_cmp(&x.ratio)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vpk::Entry;

    fn entry(path: &str, crc: u32) -> Entry {
        Entry { path: path.into(), crc, len: 10 }
    }

    fn data(addons: Vec<(&str, Vec<Entry>)>) -> ScanData {
        ScanData {
            game_dir: Default::default(),
            addons: Vec::new(),
            files: addons.into_iter().map(|(k, e)| (k.to_string(), e)).collect(),
            fingerprint: 0,
            list_hash: 0,
        }
    }

    #[test]
    fn earlier_addon_wins_and_identical_is_harmless() {
        let d = data(vec![
            ("a", vec![entry("scripts/vscripts/coop.nut", 1), entry("missions/x.txt", 5)]),
            ("b", vec![entry("scripts/vscripts/coop.nut", 2), entry("missions/x.txt", 5)]),
        ]);
        let order = vec!["a".to_string(), "b".to_string()];
        let enabled = order.iter().cloned().collect();
        let a = analyze(&d, &order, &enabled);
        assert_eq!(a.pairs.len(), 1);
        assert_eq!(a.pairs[0].winner, "a");
        assert_eq!(a.pairs[0].severity, Severity::High);
        assert_eq!(a.pairs[0].identical, 1);
        assert!(a.stats["b"].shadowed);
    }

    #[test]
    fn detects_split_models() {
        let d = data(vec![
            ("skin", vec![entry("models/survivors/survivor_coach.mdl", 1), entry("models/survivors/survivor_coach.vvd", 1)]),
            ("full", vec![
                entry("models/survivors/survivor_coach.mdl", 2),
                entry("models/survivors/survivor_coach.vvd", 2),
                entry("models/survivors/survivor_coach.dx90.vtx", 2),
            ]),
        ]);
        let order = vec!["skin".to_string(), "full".to_string()];
        let enabled = order.iter().cloned().collect();
        let a = analyze(&d, &order, &enabled);
        assert_eq!(a.split_models.len(), 1);
        assert_eq!(a.split_models[0].severity, Severity::High);
    }

    #[test]
    fn stray_ani_is_not_a_split_but_physics_is_low() {
        let d = data(vec![
            ("a", vec![entry("models/v_models/v_pipebomb.mdl", 1), entry("models/v_models/v_pipebomb.vvd", 1)]),
            ("b", vec![
                entry("models/v_models/v_pipebomb.mdl", 2),
                entry("models/v_models/v_pipebomb.vvd", 2),
                entry("models/v_models/v_pipebomb.ani", 2),
            ]),
            ("c", vec![entry("models/props/can.mdl", 1)]),
            ("d", vec![entry("models/props/can.mdl", 2), entry("models/props/can.phy", 2)]),
        ]);
        let order: Vec<String> = ["a", "b", "c", "d"].map(String::from).to_vec();
        let enabled = order.iter().cloned().collect();
        let a = analyze(&d, &order, &enabled);
        assert_eq!(a.split_models.len(), 1);
        assert_eq!(a.split_models[0].model, "models/props/can");
        assert_eq!(a.split_models[0].severity, Severity::Low);
        assert_eq!(a.stats["c"].split_models, 0);
    }

    #[test]
    fn disabled_addons_are_ignored() {
        let d = data(vec![("a", vec![entry("sound/x.wav", 1)]), ("b", vec![entry("sound/x.wav", 2)])]);
        let order = vec!["a".to_string(), "b".to_string()];
        let enabled = ["a".to_string()].into_iter().collect();
        assert!(analyze(&d, &order, &enabled).pairs.is_empty());
    }

    #[test]
    fn addon_hook_scripts_run_side_by_side() {
        let d = data(vec![
            ("a", vec![entry("scripts/vscripts/director_base_addon.nut", 1)]),
            ("b", vec![entry("scripts/vscripts/director_base_addon.nut", 2)]),
        ]);
        let order = vec!["a".to_string(), "b".to_string()];
        let enabled = order.iter().cloned().collect();
        let a = analyze(&d, &order, &enabled);
        assert!(a.pairs.is_empty());
        assert!(!a.stats["b"].shadowed);
    }
}
