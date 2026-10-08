use saferoom_lib::{addons, analysis, steam};
use std::collections::HashSet;
use std::time::Instant;

fn main() {
    let dir = std::env::args().nth(1).map(Into::into).or_else(steam::find_game_dir).expect("Left 4 Dead 2 not found");
    let started = Instant::now();
    let data = addons::scan(&dir).expect("scan failed");
    println!("{} addons in {:?} ({})", data.addons.len(), started.elapsed(), dir.display());
    for a in data.addons.iter().filter(|a| a.error.is_some()) {
        println!("  unreadable: {} {:?}", a.key, a.error);
    }

    let order: Vec<String> = data.addons.iter().map(|a| a.key.clone()).collect();
    let enabled: HashSet<String> = data.addons.iter().filter(|a| a.enabled).map(|a| a.key.clone()).collect();
    let started = Instant::now();
    let result = analysis::analyze(&data, &order, &enabled);
    println!("analysis in {:?}: {} pairs, {} split models", started.elapsed(), result.pairs.len(), result.split_models.len());

    let title = |k: &str| data.addons.iter().find(|a| a.key == k).map(|a| a.title.clone()).unwrap_or_default();
    for p in result.pairs.iter().take(25) {
        println!(
            "  [{:?}] {} > {}  ({} files, {} identical) {:?}",
            p.severity,
            title(&p.winner),
            title(&p.loser),
            p.total,
            p.identical,
            p.categories
        );
    }
    for s in result.split_models.iter().take(10) {
        println!("  split [{:?}] {} via {:?}", s.severity, s.model, s.addons.iter().map(|k| title(k)).collect::<Vec<_>>());
    }
    for (k, s) in &result.stats {
        if s.shadowed {
            println!("  fully overridden: {}", title(k));
        }
    }
}
