use saferoom_lib::{configure, Config};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindow;

fn crc(data: &[u8]) -> u32 {
    data.iter().fold(2166136261u32, |h, b| (h ^ *b as u32).wrapping_mul(16777619))
}

fn write_vpk(path: &Path, files: &[(&str, &[u8])]) {
    let mut tree_map: BTreeMap<String, BTreeMap<String, Vec<(String, &[u8])>>> = BTreeMap::new();
    for (full, data) in files {
        let (dir, file) = full.rsplit_once('/').map(|(d, f)| (d.to_string(), f)).unwrap_or((" ".into(), full));
        let (name, ext) = file.rsplit_once('.').unwrap();
        tree_map.entry(ext.into()).or_default().entry(dir).or_default().push((name.into(), *data));
    }
    let mut tree: Vec<u8> = Vec::new();
    let mut blob: Vec<u8> = Vec::new();
    for (ext, dirs) in &tree_map {
        tree.extend(ext.as_bytes());
        tree.push(0);
        for (dir, names) in dirs {
            tree.extend(dir.as_bytes());
            tree.push(0);
            for (name, data) in names {
                tree.extend(name.as_bytes());
                tree.push(0);
                tree.extend(crc(data).to_le_bytes());
                tree.extend(0u16.to_le_bytes());
                tree.extend(0x7fffu16.to_le_bytes());
                tree.extend((blob.len() as u32).to_le_bytes());
                tree.extend((data.len() as u32).to_le_bytes());
                tree.extend(0xffffu16.to_le_bytes());
                blob.extend(*data);
            }
            tree.push(0);
        }
        tree.push(0);
    }
    tree.push(0);
    let mut out = Vec::new();
    out.extend(0x55aa1234u32.to_le_bytes());
    out.extend(1u32.to_le_bytes());
    out.extend((tree.len() as u32).to_le_bytes());
    out.extend(tree);
    out.extend(blob);
    fs::write(path, out).unwrap();
}

struct Fixture {
    root: PathBuf,
    game: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("saferoom-ipc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let game = root.join("Left 4 Dead 2").join("left4dead2");
        let workshop = game.join("addons").join("workshop");
        fs::create_dir_all(&workshop).unwrap();
        fs::write(game.join("gameinfo.txt"), "\"GameInfo\" {}").unwrap();
        write_vpk(
            &workshop.join("111.vpk"),
            &[("addoninfo.txt", b"\"AddonInfo\" { addontitle \"Big Texture Pack\" addonauthor \"tester\" }"), ("materials/a.vtf", b"aaa"), ("materials/b.vtf", b"b"), ("materials/c.vtf", b"c"), ("materials/d.vtf", b"d")],
        );
        write_vpk(&workshop.join("222.vpk"), &[("addoninfo.txt", b"AddonInfo { addontitle \"Gascan Skin\" }"), ("materials/a.vtf", b"zzz")]);
        write_vpk(&game.join("addons").join("local.vpk"), &[("sound/x.wav", b"wav")]);
        fs::write(game.join("addonlist.txt"), "\"AddonList\"\n{\n\t\"workshop\\111.vpk\"\t\t\"1\"\n\t\"workshop\\222.vpk\"\t\t\"1\"\n}\n").unwrap();
        Fixture { root, game }
    }

    fn list(&self) -> String {
        fs::read_to_string(self.game.join("addonlist.txt")).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn call(webview: &WebviewWindow<tauri::test::MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().unwrap())
}

#[test]
fn full_workflow_through_ipc() {
    let fx = Fixture::new();
    let app = configure(mock_builder(), Config { data_dir: Some(fx.root.join("data")), skip_game_check: true })
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

    let scan = call(&webview, "scan", json!({ "gameDir": fx.root.join("Left 4 Dead 2") })).expect("scan");
    let addons = scan["addons"].as_array().unwrap();
    let keys: Vec<&str> = addons.iter().map(|a| a["key"].as_str().unwrap()).collect();
    assert_eq!(keys, ["workshop\\111.vpk", "workshop\\222.vpk", "local.vpk"]);
    assert_eq!(addons[0]["title"], "Big Texture Pack");
    assert_eq!(addons[1]["title"], "Gascan Skin");
    assert_eq!(addons[2]["listed"], false);
    assert_eq!(addons[2]["enabled"], true);

    let all: Vec<&str> = keys.clone();
    let analysis = call(&webview, "analyze", json!({ "order": all, "enabled": all })).expect("analyze");
    assert_eq!(analysis["pairs"].as_array().unwrap().len(), 1);
    assert_eq!(analysis["pairs"][0]["winner"], "workshop\\111.vpk");

    let plan = call(
        &webview,
        "arrange",
        json!({ "order": all, "enabled": all, "rules": [], "options": { "fixModels": true, "preferSpecific": true } }),
    )
    .expect("arrange");
    assert_eq!(plan["order"][0], "workshop\\222.vpk", "the single-file skin should beat the pack");
    assert_eq!(plan["changes"][0]["reason"], "specific");

    let ruled = call(
        &webview,
        "arrange",
        json!({ "order": all, "enabled": all, "rules": [{ "winner": "workshop\\111.vpk", "loser": "workshop\\222.vpk" }], "options": { "fixModels": true, "preferSpecific": true } }),
    )
    .expect("arrange with rule");
    assert_eq!(ruled["order"][0], "workshop\\111.vpk");

    let status = call(&webview, "status", json!({})).expect("status");
    assert_eq!(status["externalChange"], false);

    let new_order = ["workshop\\222.vpk", "workshop\\111.vpk", "local.vpk"];
    call(&webview, "save_addonlist", json!({ "order": new_order, "enabled": ["workshop\\222.vpk", "local.vpk"] })).expect("save");
    assert_eq!(fx.list(), "\"AddonList\"\n{\n\t\"workshop\\222.vpk\"\t\t\"1\"\n\t\"workshop\\111.vpk\"\t\t\"0\"\n\t\"local.vpk\"\t\t\"1\"\n}\n");
    let backups = call(&webview, "list_backups", json!({})).expect("backups");
    assert_eq!(backups.as_array().unwrap().len(), 1);
    assert_eq!(backups[0]["enabled"], 2);

    assert_eq!(call(&webview, "status", json!({})).unwrap()["externalChange"], false, "our own save is not an external change");

    fs::write(fx.game.join("addonlist.txt"), "\"AddonList\"\n{\n\t\"workshop\\111.vpk\"\t\t\"1\"\n}\n").unwrap();
    assert_eq!(call(&webview, "status", json!({})).unwrap()["externalChange"], true);
    let stale = call(&webview, "save_addonlist", json!({ "order": new_order, "enabled": new_order })).unwrap_err();
    assert!(stale.as_str().unwrap().starts_with(saferoom_lib::STALE_PREFIX), "{stale}");
    call(&webview, "save_addonlist", json!({ "order": new_order, "enabled": new_order, "force": true })).expect("forced save");
    assert!(fx.list().contains("\"workshop\\111.vpk\"\t\t\"1\""));

    let rescan = call(&webview, "scan", json!({ "gameDir": fx.game })).expect("rescan");
    assert_eq!(rescan["addons"][0]["key"], "workshop\\222.vpk");

    fs::write(fx.game.join("console.log"), "Loading map\nMaterial materials/a not found!\nHost_Error: something broke\n").unwrap();
    let log = call(&webview, "read_console_log", json!({})).expect("log");
    let issues = log["issues"].as_array().unwrap();
    assert_eq!(issues[0]["kind"], "crash");
    let material = issues.iter().find(|i| i["kind"] == "material").expect("material issue");
    assert_eq!(material["addons"][0], "workshop\\222.vpk");
    call(&webview, "archive_console_log", json!({})).expect("archive");
    assert!(!fx.game.join("console.log").exists());

    call(&webview, "store_set", json!({ "name": "rules", "value": [{ "winner": "a", "loser": "b" }] })).expect("store_set");
    assert_eq!(call(&webview, "store_get", json!({ "name": "rules" })).unwrap()[0]["winner"], "a");
    assert!(call(&webview, "store_get", json!({ "name": "../evil" })).is_err());

    let export_path = fx.root.join("export.json");
    let config = json!({ "format": "saferoom-config", "version": 1, "layout": { "order": new_order, "enabled": ["local.vpk"] } });
    call(&webview, "export_config", json!({ "path": export_path, "config": config })).expect("export");
    let imported = call(&webview, "import_config", json!({ "path": export_path })).expect("import");
    assert_eq!(imported["layout"]["enabled"][0], "local.vpk");
    fs::write(fx.root.join("other.json"), r#"{"hello":1}"#).unwrap();
    assert!(call(&webview, "import_config", json!({ "path": fx.root.join("other.json") })).unwrap_err().as_str().unwrap().contains("isn't a Saferoom"));
    assert!(!call(&webview, "machine_name", json!({})).unwrap().as_str().unwrap().is_empty());

    let backups = call(&webview, "list_backups", json!({})).unwrap();
    let oldest = backups.as_array().unwrap().last().unwrap()["name"].as_str().unwrap().to_string();
    call(&webview, "restore_backup", json!({ "name": oldest })).expect("restore");
    assert!(fx.list().contains("\"workshop\\111.vpk\"\t\t\"1\"\n\t\"workshop\\222.vpk\""));
}
