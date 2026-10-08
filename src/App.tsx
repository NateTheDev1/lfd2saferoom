import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { AddonDrawer } from "./components/AddonDrawer";
import { Arrange } from "./components/Arrange";
import { Backups } from "./components/Backups";
import { Conflicts } from "./components/Conflicts";
import { CrashHunter } from "./components/CrashHunter";
import { GameLog } from "./components/GameLog";
import { LoadOrder } from "./components/LoadOrder";
import { Profiles } from "./components/Profiles";
import { SaveReview } from "./components/SaveReview";
import { useStore, type View } from "./store";

function isTextField(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
}

function useShortcuts() {
  const { requestSave, undo, redo, setSelected, reviewOpen, rescan, gameDir } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (key === "f5" || (mod && key === "r")) {
        e.preventDefault();
        rescan(gameDir ?? undefined);
      } else if (mod && key === "s") {
        e.preventDefault();
        requestSave();
      } else if (mod && key === "f") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".content .search")?.focus();
      } else if (mod && !isTextField(e.target) && ((key === "z" && e.shiftKey) || key === "y")) {
        e.preventDefault();
        redo();
      } else if (mod && !isTextField(e.target) && key === "z") {
        e.preventDefault();
        undo();
      } else if (key === "escape" && !reviewOpen) {
        if (isTextField(e.target)) (e.target as HTMLElement).blur();
        else setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestSave, undo, redo, setSelected, reviewOpen, rescan, gameDir]);
}

export function App() {
  const store = useStore();
  const { scanError, gameDir, scanning, view, setView, analysis, selected, toasts, requirementIssues, externalChange, dirty, rescanKeepingEdits } = store;
  useShortcuts();

  if (!gameDir) return <Setup busy={scanning} error={scanError} onScan={store.rescan} />;

  const breaking =
    (analysis?.pairs.filter((p) => p.severity === "high").length ?? 0) + (analysis?.splitModels.filter((s) => s.severity === "high").length ?? 0);
  const reqs = Object.keys(requirementIssues).length;
  const nav: { id: View; label: string; badge?: number; tone?: string }[] = [
    { id: "order", label: "Load order" },
    { id: "arrange", label: "Auto-arrange" },
    { id: "conflicts", label: "Conflicts", badge: breaking + reqs || undefined },
    { id: "log", label: "Game log" },
    { id: "hunter", label: "Crash hunter" },
    { id: "profiles", label: "Profiles & transfer" },
    { id: "backups", label: "Backups" },
  ];

  return (
    <div className={`shell ${selected ? "with-drawer" : ""}`}>
      <TopBar />
      <nav className="sidebar">
        {nav.map((n) => (
          <button type="button" key={n.id} className={view === n.id ? "active" : ""} onClick={() => setView(n.id)}>
            {n.label}
            {n.badge ? <span className="badge">{n.badge}</span> : null}
          </button>
        ))}
        <div className="sidebar-foot muted small">
          <div title={gameDir}>{gameDir.replace(/\\left4dead2$/i, "")}</div>
          <div className="kbd-hint">Ctrl+S save · Ctrl+Z undo · Ctrl+F search</div>
        </div>
      </nav>
      <main className="content">
        {externalChange && dirty && (
          <div className="banner warn sticky">
            Steam or the game changed addonlist.txt while you were editing.
            <button type="button" className="btn sm" onClick={rescanKeepingEdits}>
              Rescan and keep my edits
            </button>
          </div>
        )}
        {view === "order" && <LoadOrder />}
        {view === "arrange" && <Arrange />}
        {view === "conflicts" && <Conflicts />}
        {view === "log" && <GameLog />}
        {view === "hunter" && <CrashHunter />}
        {view === "profiles" && <Profiles />}
        {view === "backups" && <Backups />}
      </main>
      {selected && <AddonDrawer />}
      <SaveReview />
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function TopBar() {
  const { dirty, requestSave, discard, gameRunning, rescan, gameDir, scanning, notify, undo, redo, canUndo, canRedo } = useStore();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">+</span>
        Saferoom
      </div>
      <div className={`status ${gameRunning ? "running" : ""}`}>
        <span className="dot" />
        {gameRunning ? "L4D2 is running, close it to save" : "L4D2 closed"}
      </div>
      <div className="spacer" />
      <div className="btn-group">
        <button type="button" className="btn ghost sm" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo">
          ↶
        </button>
        <button type="button" className="btn ghost sm" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)" aria-label="Redo">
          ↷
        </button>
      </div>
      <button type="button" className="btn ghost" disabled={scanning} onClick={() => rescan(gameDir ?? undefined)} title="Rescan (F5)">
        {scanning ? "Scanning…" : "Rescan"}
      </button>
      <button type="button" className="btn ghost" onClick={() => api.launchGame().catch((e) => notify(errorText(e), "error"))}>
        Launch game
      </button>
      {dirty && (
        <button type="button" className="btn ghost" onClick={discard}>
          Discard
        </button>
      )}
      <button type="button" className="btn primary" disabled={!dirty || gameRunning} onClick={requestSave} title="Save (Ctrl+S)">
        {dirty ? "Review & save" : "Saved"}
      </button>
    </header>
  );
}

function Setup({ busy, error, onScan }: { busy: boolean; error: string | null; onScan: (dir?: string) => void }) {
  const [dir, setDir] = useState("");
  return (
    <div className="setup">
      <div className="panel">
        <h1>
          <span className="brand-mark">+</span> Saferoom
        </h1>
        {busy && <p className="muted">Looking for Left 4 Dead 2…</p>}
        {!busy && error && (
          <>
            <p className="bad-text">{error}</p>
            <p className="muted">Paste your Left 4 Dead 2 install folder:</p>
            <form
              className="row-form"
              onSubmit={(e) => {
                e.preventDefault();
                onScan(dir.trim());
              }}
            >
              <input className="search" placeholder="D:\SteamLibrary\steamapps\common\Left 4 Dead 2" value={dir} onChange={(e) => setDir(e.target.value)} />
              <button type="submit" className="btn primary" disabled={!dir.trim()}>
                Scan
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
