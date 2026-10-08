import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useStore } from "../store";
import { applyArrangeOptions, buildExport, mergeProfiles, mergeRules, planImport, type ImportPlan, type Profile } from "../transfer";
import { formatBytes, formatDate, plural } from "./common";

const workshopUrl = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;

export function Profiles() {
  const { order, enabled, applyLayout, notify, addonsByKey, name, rules, pins, replaceRules, replacePins, dirty } = useStore();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [report, setReport] = useState<ImportPlan | null>(null);

  const loadProfiles = useCallback(() => {
    api.storeGet<Profile[]>("profiles").then((p) => setProfiles(p ?? [])).catch((e) => notify(errorText(e), "error"));
  }, [notify]);

  useEffect(loadProfiles, [loadProfiles]);

  const persist = async (next: Profile[]) => {
    try {
      await api.storeSet("profiles", next);
      setProfiles(next);
    } catch (e) {
      notify(errorText(e), "error");
    }
  };

  const saveCurrent = async () => {
    const trimmed = profileName.trim();
    if (!trimmed) return;
    await persist([{ name: trimmed, created: Date.now(), order, enabled: [...enabled] }, ...profiles.filter((p) => p.name !== trimmed)]);
    setProfileName("");
    notify(`Saved profile “${trimmed}”`, "success");
  };

  const exportConfig = async () => {
    try {
      const machine = await api.machineName();
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await saveDialog({
        title: "Export Saferoom configuration",
        defaultPath: `saferoom-${machine}-${stamp}.json`,
        filters: [{ name: "Saferoom configuration", extensions: ["json"] }],
      });
      if (!path) return;
      const config = buildExport({ machine, order, enabled, addonsByKey, name, profiles, rules, pins });
      await api.exportConfig(path, config);
      notify(`Exported ${plural(config.addons.length, "add-on")}, ${plural(profiles.length, "profile")} and ${plural(rules.length, "decision")}`, "success");
    } catch (e) {
      notify(errorText(e), "error");
    }
  };

  const importConfig = async () => {
    try {
      const path = await openDialog({
        title: "Import Saferoom configuration",
        multiple: false,
        directory: false,
        filters: [{ name: "Saferoom configuration", extensions: ["json"] }],
      });
      if (!path || Array.isArray(path)) return;
      const plan = planImport(await api.importConfig(path), order, enabled);
      const snapshot: Profile = {
        name: `From ${plan.config.machine} (${new Date(plan.config.exportedAt).toLocaleDateString()})`,
        created: Date.now(),
        order: plan.config.layout.order,
        enabled: plan.config.layout.enabled,
      };
      await persist(mergeProfiles(profiles, [snapshot, ...(plan.config.profiles ?? [])]));
      replaceRules(mergeRules(rules, plan.config.rules ?? []));
      replacePins(new Set([...pins, ...(plan.config.pins ?? [])]));
      applyArrangeOptions(plan.config.arrangeOptions);
      applyLayout(plan.order, plan.enabled);
      setReport(plan);
    } catch (e) {
      notify(errorText(e), "error");
    }
  };

  return (
    <section className="view narrow">
      <header className="view-head">
        <div>
          <h1>Profiles &amp; transfer</h1>
          <p className="muted">Snapshots of which add-ons are on and in what order. Keep one for co-op with friends, one for solo, one for vanilla versus.</p>
        </div>
      </header>

      <div className="panel transfer">
        <div>
          <strong>Move to another PC</strong>
          <p className="muted small">
            Exports load order, enabled add-ons, profiles, your Auto-arrange decisions and crash-hunter pins to one file. Import it in Saferoom on the
            other PC.
            {dirty && " Includes your unsaved changes."}
          </p>
        </div>
        <div className="btn-group">
          <button type="button" className="btn" onClick={exportConfig}>
            Export…
          </button>
          <button type="button" className="btn" onClick={importConfig}>
            Import…
          </button>
        </div>
      </div>

      <form
        className="panel row-form"
        onSubmit={(e) => {
          e.preventDefault();
          saveCurrent();
        }}
      >
        <input className="search" placeholder="Profile name, e.g. Co-op night" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
        <button type="submit" className="btn primary" disabled={!profileName.trim()}>
          Save current setup
        </button>
      </form>

      <div className="cards">
        {profiles.map((p) => {
          const missing = p.enabled.filter((k) => !addonsByKey.has(k)).length;
          return (
            <article key={p.name} className="card">
              <div className="card-head static">
                <div>
                  <div className="addon-title">{p.name}</div>
                  <div className="muted small">
                    {p.enabled.length} enabled · saved {formatDate(p.created)}
                    {missing > 0 && ` · ${missing} not installed here`}
                  </div>
                </div>
                <div className="card-meta">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      applyLayout(p.order, p.enabled);
                      notify(`Loaded “${p.name}”. Review it, then Save to apply.`, "info");
                    }}
                  >
                    Load
                  </button>
                  <button type="button" className="btn ghost" onClick={() => persist(profiles.filter((x) => x.name !== p.name))}>
                    Delete
                  </button>
                </div>
              </div>
            </article>
          );
        })}
        {!profiles.length && <p className="empty">No profiles yet.</p>}
      </div>

      {report && <ImportReport plan={report} onClose={() => setReport(null)} />}
    </section>
  );
}

function ImportReport({ plan, onClose }: { plan: ImportPlan; onClose: () => void }) {
  const { notify, requestSave } = useStore();
  const workshopMissing = plan.missing.filter((a) => a.workshopId);
  const localMissing = plan.missing.filter((a) => !a.workshopId);

  const copyLinks = async () => {
    try {
      await navigator.clipboard.writeText(workshopMissing.map((a) => `${a.title}: ${workshopUrl(a.workshopId!)}`).join("\n"));
      notify("Copied Workshop links", "success");
    } catch {
      notify("Couldn't copy to the clipboard", "error");
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="import-title">Imported from {plan.config.machine}</h2>
        <p className="muted small">Exported {formatDate(plan.config.exportedAt)}. Nothing is written to the game until you save.</p>

        <div className="review-grid three">
          <div className="review-stat tone-ok">
            <strong>{plan.matched}</strong>
            <span>placed in order</span>
          </div>
          <div className={`review-stat ${plan.missing.length ? "tone-bad" : ""}`}>
            <strong>{plan.missing.length}</strong>
            <span>not installed here</span>
          </div>
          <div className="review-stat">
            <strong>{plan.extras.length}</strong>
            <span>only on this PC</span>
          </div>
        </div>

        <div className="review-body">
          {workshopMissing.length > 0 && (
            <section>
              <h3>Not downloaded yet ({workshopMissing.length})</h3>
              <p className="hint">
                If this PC uses the same Steam account, they're already subscribed: launch L4D2 once, wait for the Addons spinner on the main menu to finish,
                quit, then load the “From {plan.config.machine}” profile to slot them in. Otherwise subscribe from the links.
              </p>
              <ul className="mini-list">
                {workshopMissing.slice(0, 50).map((a) => (
                  <li key={a.key}>
                    <button type="button" className="addon-link" onClick={() => openUrl(workshopUrl(a.workshopId!))}>
                      {a.title}
                    </button>
                    <span className="muted small">{formatBytes(a.size)}</span>
                  </li>
                ))}
                {workshopMissing.length > 50 && <li className="muted small">…and {workshopMissing.length - 50} more</li>}
              </ul>
            </section>
          )}
          {localMissing.length > 0 && (
            <section>
              <h3>Local add-ons to copy over ({localMissing.length})</h3>
              <p className="hint">These were installed by hand. Copy them from the other PC's left4dead2\addons folder.</p>
              <ul className="mini-list">
                {localMissing.map((a) => (
                  <li key={a.key}>
                    <code>{a.fileName}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan.extras.length > 0 && (
            <p className="hint">{plural(plan.extras.length, "add-on")} only on this PC kept their on/off state and went to the bottom of the order.</p>
          )}
        </div>

        <div className="modal-actions">
          {workshopMissing.length > 0 && (
            <button type="button" className="btn ghost" onClick={copyLinks}>
              Copy Workshop links
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              onClose();
              requestSave();
            }}
          >
            Review &amp; save
          </button>
        </div>
      </div>
    </div>
  );
}
