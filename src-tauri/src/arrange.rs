use crate::addons::ScanData;
use crate::analysis::{self, classify, is_core_part, model_stem, Severity};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet};

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub winner: String,
    pub loser: String,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub fix_models: bool,
    pub prefer_specific: bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Rule,
    Model,
    Specific,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub winner: String,
    pub loser: String,
    pub reason: Reason,
    pub model: Option<String>,
    pub winner_files: usize,
    pub loser_files: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Unresolved {
    pub kind: &'static str,
    pub keys: Vec<String>,
    pub detail: String,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub breaking: usize,
    pub notable: usize,
    pub cosmetic: usize,
    pub split_models: usize,
    pub shadowed: usize,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub order: Vec<String>,
    pub changes: Vec<Change>,
    pub moved: usize,
    pub unresolved: Vec<Unresolved>,
    pub before: Summary,
    pub after: Summary,
}

struct Edge {
    from: usize,
    to: usize,
    reason: Reason,
    model: Option<String>,
}

#[derive(Default)]
struct PairInfo {
    differing: usize,
    asset_only: bool,
}

const ASSET_CATEGORIES: &[&str] = &["model", "material", "sound", "particle", "ui", "other"];
const SPECIFICITY_RATIO: usize = 3;

struct Graph {
    adj: Vec<Vec<usize>>,
}

impl Graph {
    fn reaches(&self, start: usize, target: usize) -> bool {
        let mut stack = vec![start];
        let mut seen = vec![false; self.adj.len()];
        while let Some(n) = stack.pop() {
            if n == target {
                return true;
            }
            if std::mem::replace(&mut seen[n], true) {
                continue;
            }
            stack.extend(self.adj[n].iter().copied());
        }
        false
    }

    fn try_add(&mut self, from: usize, to: usize) -> bool {
        if from == to || self.adj[from].contains(&to) {
            return from != to;
        }
        if self.reaches(to, from) {
            return false;
        }
        self.adj[from].push(to);
        true
    }

    fn reverse_topo(&self) -> Vec<usize> {
        let n = self.adj.len();
        let mut outdegree: Vec<usize> = self.adj.iter().map(Vec::len).collect();
        let mut preds = vec![Vec::new(); n];
        for (from, targets) in self.adj.iter().enumerate() {
            for &t in targets {
                preds[t].push(from);
            }
        }
        let mut ready: BinaryHeap<usize> = (0..n).filter(|&i| outdegree[i] == 0).collect();
        let mut out = Vec::with_capacity(n);
        while let Some(i) = ready.pop() {
            out.push(i);
            for &p in &preds[i] {
                outdegree[p] -= 1;
                if outdegree[p] == 0 {
                    ready.push(p);
                }
            }
        }
        out.reverse();
        out
    }

    fn stable_topo(&self) -> Vec<usize> {
        let n = self.adj.len();
        let mut indegree = vec![0usize; n];
        for targets in &self.adj {
            for &t in targets {
                indegree[t] += 1;
            }
        }
        let mut ready: BinaryHeap<Reverse<usize>> = (0..n).filter(|&i| indegree[i] == 0).map(Reverse).collect();
        let mut out = Vec::with_capacity(n);
        while let Some(Reverse(i)) = ready.pop() {
            out.push(i);
            for &t in &self.adj[i] {
                indegree[t] -= 1;
                if indegree[t] == 0 {
                    ready.push(Reverse(t));
                }
            }
        }
        out
    }
}

fn drags_needed(sequence: &[usize]) -> usize {
    let mut tails: Vec<usize> = Vec::new();
    for &x in sequence {
        let at = tails.partition_point(|&t| t < x);
        if at == tails.len() {
            tails.push(x);
        } else {
            tails[at] = x;
        }
    }
    sequence.len() - tails.len()
}

fn summarize(a: &analysis::Analysis) -> Summary {
    let count = |s: Severity| a.pairs.iter().filter(|p| p.severity == s).count();
    Summary {
        breaking: count(Severity::High),
        notable: count(Severity::Medium),
        cosmetic: count(Severity::Low),
        split_models: a.split_models.len(),
        shadowed: a.stats.values().filter(|s| s.shadowed).count(),
    }
}

pub fn plan(data: &ScanData, order: &[String], enabled: &HashSet<String>, rules: &[Rule], opts: Options) -> Plan {
    let index: HashMap<&str, usize> = order.iter().enumerate().map(|(i, k)| (k.as_str(), i)).collect();
    let mut files_count = vec![0usize; order.len()];
    let mut providers: HashMap<&str, Vec<(usize, u32, u32)>> = HashMap::new();
    for (i, key) in order.iter().enumerate() {
        if !enabled.contains(key) {
            continue;
        }
        let Some(entries) = data.files.get(key) else { continue };
        for e in entries {
            if classify(&e.path).is_some() {
                files_count[i] += 1;
                providers.entry(e.path.as_str()).or_default().push((i, e.crc, e.len));
            }
        }
    }

    let mut pairs: HashMap<(usize, usize), PairInfo> = HashMap::new();
    let mut model_parts: HashMap<&str, HashMap<usize, BTreeSet<&'static str>>> = HashMap::new();
    for (path, provs) in &providers {
        if let Some((stem, suffix)) = model_stem(path).filter(|_| is_core_part(path)) {
            let group = model_parts.entry(stem).or_default();
            for (i, _, _) in provs {
                group.entry(*i).or_default().insert(suffix);
            }
        }
        if provs.len() < 2 {
            continue;
        }
        let category = classify(path).map(|c| c.0).unwrap_or("other");
        for x in 0..provs.len() {
            for y in x + 1..provs.len() {
                let (a, b) = (provs[x], provs[y]);
                if a.1 == b.1 && a.2 == b.2 {
                    continue;
                }
                let key = (a.0.min(b.0), a.0.max(b.0));
                let info = pairs.entry(key).or_insert(PairInfo { differing: 0, asset_only: true });
                info.differing += 1;
                info.asset_only &= ASSET_CATEGORIES.contains(&category);
            }
        }
    }

    let mut edges: Vec<Edge> = Vec::new();
    let mut ruled: HashSet<(usize, usize)> = HashSet::new();
    for r in rules {
        if let (Some(&w), Some(&l)) = (index.get(r.winner.as_str()), index.get(r.loser.as_str())) {
            edges.push(Edge { from: w, to: l, reason: Reason::Rule, model: None });
            ruled.insert((w.min(l), w.max(l)));
        }
    }

    if opts.fix_models {
        let mut stems: Vec<_> = model_parts.iter().filter(|(_, g)| g.len() > 1).collect();
        stems.sort_by_key(|(s, _)| **s);
        for (stem, group) in stems {
            let distinct_sets = group.values().collect::<HashSet<_>>().len() > 1;
            if !distinct_sets {
                continue;
            }
            let mdl_winner = group.iter().filter(|(_, set)| set.contains(".mdl")).map(|(i, _)| *i).min();
            let owner = *group
                .iter()
                .max_by_key(|(i, set)| (set.len(), Some(**i) == mdl_winner, Reverse(**i)))
                .map(|(i, _)| i)
                .expect("non-empty");
            let owner_set = &group[&owner];
            let mut others: Vec<usize> = group.iter().filter(|(i, set)| **i != owner && *set != owner_set).map(|(i, _)| *i).collect();
            others.sort();
            for other in others {
                edges.push(Edge { from: owner, to: other, reason: Reason::Model, model: Some(stem.to_string()) });
            }
        }
    }

    let mut pair_keys: Vec<(usize, usize)> = pairs.keys().copied().collect();
    pair_keys.sort();
    if opts.prefer_specific {
        for &(a, b) in &pair_keys {
            if !pairs[&(a, b)].asset_only || ruled.contains(&(a, b)) {
                continue;
            }
            let (fa, fb) = (files_count[a], files_count[b]);
            if fa * SPECIFICITY_RATIO <= fb {
                edges.push(Edge { from: a, to: b, reason: Reason::Specific, model: None });
            } else if fb * SPECIFICITY_RATIO <= fa {
                edges.push(Edge { from: b, to: a, reason: Reason::Specific, model: None });
            }
        }
    }

    let mut graph = Graph { adj: vec![Vec::new(); order.len()] };
    let mut accepted: Vec<&Edge> = Vec::new();
    let mut unresolved = Vec::new();
    for e in &edges {
        if graph.try_add(e.from, e.to) {
            accepted.push(e);
        } else if e.reason != Reason::Specific {
            let detail = match e.reason {
                Reason::Rule => "This decision contradicts another one of your decisions".to_string(),
                _ => format!("{} stays mixed because one of your decisions puts the other add-on first", e.model.as_deref().unwrap_or("model")),
            };
            unresolved.push(Unresolved { kind: "blocked", keys: vec![order[e.from].clone(), order[e.to].clone()], detail });
        }
    }
    for &(a, b) in &pair_keys {
        graph.try_add(a, b);
    }

    let forward = graph.stable_topo();
    let backward = graph.reverse_topo();
    let new_indices = if drags_needed(&backward) < drags_needed(&forward) { backward } else { forward };
    let new_order: Vec<String> = new_indices.iter().map(|&i| order[i].clone()).collect();

    let mut seen = HashSet::new();
    let changes: Vec<Change> = accepted
        .iter()
        .filter(|e| e.from > e.to && seen.insert((e.from, e.to)))
        .map(|e| Change {
            winner: order[e.from].clone(),
            loser: order[e.to].clone(),
            reason: e.reason,
            model: e.model.clone(),
            winner_files: files_count[e.from],
            loser_files: files_count[e.to],
        })
        .collect();
    let moved = drags_needed(&new_indices);

    let before_analysis = analysis::analyze(data, order, enabled);
    let after_analysis = analysis::analyze(data, &new_order, enabled);

    for split in after_analysis.split_models.iter().filter(|s| s.severity == Severity::High) {
        unresolved.push(Unresolved {
            kind: "model",
            keys: split.addons.clone(),
            detail: format!("{} stays mixed: no single add-on ships every part of it. Disable all but one of these.", split.model),
        });
    }
    for pair in after_analysis.pairs.iter().filter(|p| p.severity == Severity::High) {
        unresolved.push(Unresolved {
            kind: "script",
            keys: vec![pair.winner.clone(), pair.loser.clone()],
            detail: format!(
                "Both replace the same {} file(s). Order only picks which copy is used; it can't merge them. Disable one if they misbehave.",
                pair.total - pair.identical
            ),
        });
    }
    for d in after_analysis.duplicates.iter().filter(|d| d.same_title) {
        unresolved.push(Unresolved {
            kind: "duplicate",
            keys: vec![d.a.clone(), d.b.clone()],
            detail: "Looks like two versions of the same mod. Keep one.".into(),
        });
    }

    Plan {
        order: new_order,
        changes,
        moved,
        unresolved,
        before: summarize(&before_analysis),
        after: summarize(&after_analysis),
    }
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

    fn keys(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    const ALL: Options = Options { fix_models: true, prefer_specific: true };

    #[test]
    fn specific_mod_beats_big_pack() {
        let mut pack: Vec<Entry> = (0..30).map(|i| entry(&format!("materials/pack/{i}.vtf"), 1)).collect();
        pack.push(entry("materials/models/props/gascan.vtf", 1));
        let d = data(vec![("pack", pack), ("filler", vec![entry("sound/a.wav", 1)]), ("gascan", vec![entry("materials/models/props/gascan.vtf", 2)])]);
        let order = keys(&["pack", "filler", "gascan"]);
        let enabled = order.iter().cloned().collect();
        let p = plan(&d, &order, &enabled, &[], ALL);
        assert!(p.order.iter().position(|k| k == "gascan") < p.order.iter().position(|k| k == "pack"));
        assert_eq!(p.changes.len(), 1);
        assert_eq!(p.changes[0].reason, Reason::Specific);
    }

    #[test]
    fn fixes_split_model_and_keeps_unrelated_order() {
        let d = data(vec![
            ("a", vec![entry("sound/x.wav", 1)]),
            ("skin", vec![entry("models/v_models/v_pipebomb.mdl", 1)]),
            ("b", vec![entry("sound/x.wav", 2)]),
            ("full", vec![
                entry("models/v_models/v_pipebomb.mdl", 2),
                entry("models/v_models/v_pipebomb.vvd", 2),
                entry("models/v_models/v_pipebomb.dx90.vtx", 2),
            ]),
        ]);
        let order = keys(&["a", "skin", "b", "full"]);
        let enabled = order.iter().cloned().collect();
        let p = plan(&d, &order, &enabled, &[], Options { fix_models: true, prefer_specific: false });
        assert_eq!(p.before.split_models, 1);
        assert_eq!(p.after.split_models, 0);
        let pos = |k: &str| p.order.iter().position(|x| x == k).unwrap();
        assert!(pos("full") < pos("skin"));
        assert!(pos("a") < pos("b"));
    }

    #[test]
    fn user_rule_beats_heuristics() {
        let big: Vec<Entry> = (0..30).map(|i| entry(&format!("materials/big/{i}.vtf"), 1)).chain([entry("materials/shared.vtf", 1)]).collect();
        let d = data(vec![("small", vec![entry("materials/shared.vtf", 2)]), ("big", big)]);
        let order = keys(&["small", "big"]);
        let enabled = order.iter().cloned().collect();
        let rules = [Rule { winner: "big".into(), loser: "small".into() }];
        let p = plan(&d, &order, &enabled, &rules, ALL);
        assert_eq!(p.order, keys(&["big", "small"]));
        assert_eq!(p.changes[0].reason, Reason::Rule);
    }

    #[test]
    fn script_conflicts_are_reported_not_reordered() {
        let d = data(vec![
            ("bots", vec![entry("scripts/vscripts/left4bots.nut", 1)]),
            ("bots2", vec![entry("scripts/vscripts/left4bots.nut", 2), entry("models/x.mdl", 1)]),
        ]);
        let order = keys(&["bots", "bots2"]);
        let enabled = order.iter().cloned().collect();
        let p = plan(&d, &order, &enabled, &[], ALL);
        assert_eq!(p.order, order);
        assert!(p.unresolved.iter().any(|u| u.kind == "script"));
    }
}
