import { useCallback, useEffect, useState } from "react";
import { api, errorText, type Backup } from "../api";
import { useStore } from "../store";
import { formatDate } from "./common";

export function Backups() {
  const { notify, rescan, gameDir, baseline } = useStore();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listBackups().then(setBackups).catch((e) => notify(errorText(e), "error"));
  }, [notify]);

  useEffect(load, [load, baseline]);

  const restore = async (name: string) => {
    try {
      await api.restoreBackup(name);
      notify("Backup restored", "success");
      setConfirming(null);
      await rescan(gameDir ?? undefined);
      load();
    } catch (e) {
      notify(errorText(e), "error");
    }
  };

  return (
    <section className="view narrow">
      <header className="view-head">
        <div>
          <h1>Backups</h1>
          <p className="muted">Every save copies the previous addonlist.txt here first. The newest 40 are kept.</p>
        </div>
      </header>
      <div className="cards">
        {backups.map((b) => (
          <article key={b.name} className="card">
            <div className="card-head static">
              <div>
                <div className="addon-title">{formatDate(b.created)}</div>
                <div className="muted small">
                  {b.enabled} of {b.entries} enabled
                </div>
              </div>
              <div className="card-meta">
                {confirming === b.name ? (
                  <>
                    <span className="muted small">Replace the current list?</span>
                    <button type="button" className="btn primary" onClick={() => restore(b.name)}>
                      Restore
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn" onClick={() => setConfirming(b.name)}>
                    Restore…
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
        {!backups.length && <p className="empty">No backups yet. One is made the first time you save.</p>}
      </div>
    </section>
  );
}
