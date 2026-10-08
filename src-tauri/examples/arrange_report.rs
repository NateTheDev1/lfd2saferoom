use saferoom_lib::{addons, arrange, steam};
use std::collections::HashSet;

fn main() {
    let dir = steam::find_game_dir().unwrap();
    let data = addons::scan(&dir).unwrap();
    let order: Vec<String> = data.addons.iter().map(|a| a.key.clone()).collect();
    let enabled: HashSet<String> = data.addons.iter().filter(|a| a.enabled).map(|a| a.key.clone()).collect();
    let title = |k: &str| data.addons.iter().find(|a| a.key == k).map(|a| a.title.clone()).unwrap_or_default();
    let t = std::time::Instant::now();
    let p = arrange::plan(&data, &order, &enabled, &[], arrange::Options { fix_models: true, prefer_specific: true });
    println!("planned in {:?}; moved {} add-ons", t.elapsed(), p.moved);
    println!("before {:?}\nafter  {:?}", p.before, p.after);
    for c in &p.changes {
        println!("  {:?}: {} ({}) above {} ({}) {:?}", c.reason, title(&c.winner), c.winner_files, title(&c.loser), c.loser_files, c.model);
    }
    for u in &p.unresolved {
        println!("  unresolved [{}] {:?}: {}", u.kind, u.keys.iter().map(|k| title(k)).collect::<Vec<_>>(), u.detail);
    }
}
