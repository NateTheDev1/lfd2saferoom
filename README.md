# Saferoom

Left 4 Dead 2 add-on manager: load order, conflict detection, auto-arrange, game-log diagnosis, crash bisecting, profiles.

## How L4D2 resolves add-ons

- `left4dead2/addonlist.txt` is the load order. An entry nearer the top wins when two add-ons ship the same file.
- The game rewrites that file on exit, so Saferoom refuses to save while `left4dead2.exe` is running. It also refuses (with a rescan-and-keep-edits option) if Steam or the game changed the file since the last scan.
- `scripts/vscripts/{mapspawn,scriptedmode,director_base,response_testbed}_addon.nut` run from every add-on, so they are not treated as conflicts.

## What it detects

| Finding | Meaning |
| --- | --- |
| Breaking | Two add-ons ship different scripts, maps, missions or talker files. Only one copy is used. |
| Notable | Model, UI or particle overrides |
| Cosmetic | Texture and sound overrides |
| Harmless | Same path, identical CRC and size (e.g. campaign parts sharing a mission file) |
| Broken model | A model's `.mdl`/`.vvd`/`.vtx` come from different add-ons. This causes stretched or invisible models, T-poses or crashes. A `.phy` from another add-on is reported as a physics-only mismatch. |
| Fully overridden | Every file in the add-on is masked by higher-priority add-ons |
| Duplicate | Same mod name with a version suffix, or two mods whose file sets mostly overlap (60%+ of the combined files) |
| Missing requirement | A Workshop "Required item" that is disabled or not subscribed |

## Auto-arrange

Builds ordering constraints in priority order, drops any that would contradict a higher-priority one, then picks the valid order that needs the fewest drags from your current one:

1. Your decisions ("Let X win", "Use X", "Keep current"), stored as rules
2. Model fixes: the add-on with the most complete set of core model files owns the model
3. Specific beats pack: on asset-only overlaps, an add-on with at least 3× fewer files wins
4. Everything else keeps its current relative order

Script and map clashes and duplicates are listed as "needs your call", since reordering can't merge them.

## Game log

Launch with `-condebug` and L4D2 writes `console.log`. Saferoom traces script errors (via the `*FUNCTION … file.nut` callstack line), missing models, materials and sounds, and `Host_Error` crashes back to the enabled add-on that ships the file.

## Data

App data (`%APPDATA%\dev.nrichards.saferoom`) holds `addonlist.txt` backups (newest 40), archived console logs, profiles, rules, pins, and the Workshop title and requirements caches. Requirement pages are fetched one at a time and cached for a week. Fetching stops on the first 403/429.

## Develop

```bash
npm install
npm run tauri dev
```

```bash
cd src-tauri && cargo test
```

`tests/ipc.rs` builds a fake game folder with real VPKs and drives every command through Tauri's mock runtime.

```bash
cd src-tauri && cargo run --release --example report
```

```bash
cd src-tauri && cargo run --release --example arrange_report
```

## Build an installer

```bash
npm run tauri build
```
