use crate::kv;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const APP_ID: u32 = 550;

#[cfg(windows)]
fn registry_steam_root() -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let user = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam")
        .and_then(|k| k.get_value::<String, _>("SteamPath"));
    let machine = || {
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\WOW6432Node\\Valve\\Steam")
            .and_then(|k| k.get_value::<String, _>("InstallPath"))
    };
    user.or_else(|_| machine()).ok().map(PathBuf::from)
}

#[cfg(not(windows))]
fn registry_steam_root() -> Option<PathBuf> {
    None
}

fn steam_root() -> Option<PathBuf> {
    registry_steam_root()
        .or_else(|| Some(PathBuf::from(r"C:\Program Files (x86)\Steam")))
        .filter(|p| p.join("steamapps").is_dir())
}

fn steam_libraries() -> Vec<PathBuf> {
    let Some(root) = steam_root() else { return Vec::new() };
    let mut libs = vec![root.clone()];
    if let Ok(text) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        let vdf = kv::parse(&text);
        if let Some(folders) = vdf.get("libraryfolders") {
            for (_, folder) in folders.entries() {
                let path = folder.get_str("path").or_else(|| folder.as_str());
                if let Some(path) = path {
                    let path = PathBuf::from(path.replace("\\\\", "\\"));
                    if !libs.contains(&path) {
                        libs.push(path);
                    }
                }
            }
        }
    }
    libs
}

pub fn normalize_game_dir(dir: &Path) -> Option<PathBuf> {
    if dir.join("addons").is_dir() || dir.join("gameinfo.txt").is_file() {
        return Some(dir.to_path_buf());
    }
    let inner = dir.join("left4dead2");
    inner.is_dir().then_some(inner)
}

pub fn find_game_dir() -> Option<PathBuf> {
    steam_libraries().into_iter().find_map(|lib| {
        let manifest = lib.join("steamapps").join(format!("appmanifest_{APP_ID}.acf"));
        let text = std::fs::read_to_string(manifest).ok()?;
        let acf = kv::parse(&text);
        let install = acf
            .get("AppState")
            .and_then(|s| s.get_str("installdir"))
            .unwrap_or("Left 4 Dead 2")
            .to_string();
        normalize_game_dir(&lib.join("steamapps").join("common").join(install))
    })
}

pub fn game_running() -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", "IMAGENAME eq left4dead2.exe", "/NH", "/FO", "CSV"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase().contains("left4dead2.exe"))
        .unwrap_or(false)
}
