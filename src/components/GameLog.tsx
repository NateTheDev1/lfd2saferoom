import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type LogIssue, type LogReport } from "../api";
import { useStore } from "../store";
import { AddonLink, formatBytes, formatDate } from "./common";

const kindLabel: Record<LogIssue["kind"], string> = {
  crash: "Crash",
  script: "Script error",
  model: "Model",
  material: "Material",
  sound: "Sound",
  error: "Error",
};

export function GameLog() {
  const { gameRunning, notify, name } = useStore();
  const [report, setReport] = useState<LogReport | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const wasRunning = useRef(gameRunning);

  const load = useCallback(() => {
    api.readConsoleLog().then(setReport).catch((e) => notify(errorText(e), "error"));
  }, [notify]);

  useEffect(load, [load]);

  useEffect(() => {
    if (wasRunning.current && !gameRunning) load();
    wasRunning.current = gameRunning;
  }, [gameRunning, load]);

  const byAddon = useMemo(() => {
    const groups = new Map<string, LogIssue[]>();
    const loose: LogIssue[] = [];
    for (const issue of report?.issues ?? []) {
      const owner = issue.addons[0];
      if (owner) groups.set(owner, [...(groups.get(owner) ?? []), issue]);
      else loose.push(issue);
    }
    const sorted = [...groups.entries()].sort((a, b) => b[1].reduce((s, i) => s + i.count, 0) - a[1].reduce((s, i) => s + i.count, 0));
    return { sorted, loose };
  }, [report]);

  const archive = async () => {
    try {
      await api.archiveConsoleLog();
      setConfirmArchive(false);
      notify("Old log moved to Saferoom's data folder. The next session starts clean.", "success");
      load();
    } catch (e) {
      notify(errorText(e), "error");
    }
  };

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Game log</h1>
          <p className="muted">
            With the <code>-condebug</code> launch option, L4D2 writes everything from its console to <code>console.log</code>. Saferoom reads it after you
            close the game and traces script errors, missing models and crashes back to the add-on that ships the file.
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn" onClick={() => api.launchGame(true).catch((e) => notify(errorText(e), "error"))}>
            Launch with logging
          </button>
          <button type="button" className="btn ghost" onClick={load}>
            Reload
          </button>
        </div>
      </header>

      {report && !report.exists && (
        <div className="panel">
          <p>
            <strong>No console.log yet.</strong>
          </p>
          <ol className="steps">
            <li>
              Click <em>Launch with logging</em>. Steam asks whether to allow the <code>-condebug</code> option; accept it.
            </li>
            <li>
              Or add <code>-condebug</code> permanently: Steam → Left 4 Dead 2 → Properties → Launch options.
            </li>
            <li>Play until the problem happens, then quit. This page reloads by itself.</li>
          </ol>
        </div>
      )}

      {report?.exists && (
        <>
          <div className="toolbar log-meta">
            <span className="muted small">
              {formatBytes(report.size)} · {report.lines.toLocaleString()} lines{report.truncated ? " (last 8 MB)" : ""} · updated {formatDate(report.modified * 1000)}
            </span>
            <div className="spacer" />
            {confirmArchive ? (
              <>
                <span className="muted small">The game must be closed. Move this log out of the way?</span>
                <button type="button" className="btn primary" disabled={gameRunning} onClick={archive}>
                  Archive log
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirmArchive(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setConfirmArchive(true)}>
                Start a fresh log…
              </button>
            )}
          </div>
          <p className="hint">The log keeps growing across sessions. Start a fresh one before reproducing a problem so only that session shows up.</p>

          {!report.issues.length && <p className="empty">No errors traced to add-ons in this log.</p>}

          <div className="cards">
            {byAddon.sorted.map(([key, issues]) => (
              <article key={key} className="card sev-border-high">
                <div className="card-head static">
                  <AddonLink k={key} />
                  <span className="muted small">
                    {issues.reduce((s, i) => s + i.count, 0)} occurrence{issues.reduce((s, i) => s + i.count, 0) === 1 ? "" : "s"}
                  </span>
                </div>
                <IssueList issues={issues} name={name} />
              </article>
            ))}
            {byAddon.loose.length > 0 && (
              <article className="card">
                <div className="card-head static">
                  <strong>Not traced to an add-on</strong>
                  <span className="muted small">Crashes and script errors from the base game or a server</span>
                </div>
                <IssueList issues={byAddon.loose} name={name} />
              </article>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function IssueList({ issues, name }: { issues: LogIssue[]; name: (k: string) => string }) {
  return (
    <ul className="issue-list">
      {issues.map((i) => (
        <li key={`${i.kind}|${i.path ?? i.text}`}>
          <span className={`pill ${i.kind === "crash" || i.kind === "script" ? "sev-high" : "sev-medium"}`}>{kindLabel[i.kind]}</span>
          <div className="issue-body">
            <code>{i.text}</code>
            <span className="muted small">
              {i.count > 1 && `${i.count}× · `}line {i.lastLine.toLocaleString()}
              {i.addons.length > 1 && ` · also shipped by ${i.addons.slice(1).map(name).join(", ")}`}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
