import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { useStore } from "../store";
import { AddonLink, SeverityPill, Thumb, Toggle, formatBytes, formatDate, plural } from "./common";

function plainText(bbcode: string) {
  return bbcode
    .replace(/\[url=[^\]]*\]/gi, "")
    .replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function AddonDrawer() {
  const { selected, setSelected, addonsByKey, name, enabled, toggle, order, moveTo, analysis, workshop, notify, pins, togglePin, requirements, keyByWorkshopId, rules, removeRule } =
    useStore();
  const [files, setFiles] = useState<string[] | null>(null);
  const addon = selected ? addonsByKey.get(selected) : undefined;

  useEffect(() => setFiles(null), [selected]);

  const related = useMemo(
    () => (analysis?.pairs ?? []).filter((p) => p.severity !== "harmless" && (p.winner === selected || p.loser === selected)),
    [analysis, selected],
  );

  if (!addon) return null;
  const info = addon.workshopId ? workshop[addon.workshopId] : undefined;
  const description = info?.description ? plainText(info.description) : addon.description;
  const index = order.indexOf(addon.key);
  const stats = analysis?.stats[addon.key];
  const reqs = addon.workshopId ? requirements[addon.workshopId] ?? [] : [];
  const myRules = rules.filter((r) => r.winner === addon.key || r.loser === addon.key);
  const updated = Math.max(addon.modified, info?.timeUpdated ?? 0);

  return (
    <aside className="drawer">
      <button type="button" className="close" aria-label="Close" onClick={() => setSelected(null)}>
        ✕
      </button>
      <div className="drawer-hero">
        <Thumb addon={addon} size={96} />
        <div>
          <h2>{name(addon.key)}</h2>
          <p className="muted small">
            {[addon.author, addon.version && `v${addon.version}`, formatBytes(addon.size), `${addon.fileCount} files`].filter(Boolean).join(" · ")}
            <br />
            Updated {formatDate(updated * 1000)}
          </p>
          <div className="addon-sub">
            {addon.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
            {info?.removed && <span className="flag bad">Removed from Workshop</span>}
          </div>
        </div>
      </div>

      <div className="drawer-row">
        <span>Enabled</span>
        <Toggle on={enabled.has(addon.key)} onChange={() => toggle(addon.key)} label="Enabled" />
      </div>
      <div className="drawer-row">
        <span>
          Priority <strong>#{index + 1}</strong> of {order.length}
        </span>
        <div className="btn-group">
          <button type="button" className="btn ghost sm" onClick={() => moveTo(addon.key, 0)} title="Move to top (wins every conflict)">
            Top
          </button>
          <button type="button" className="btn ghost sm" onClick={() => moveTo(addon.key, index - 1)} disabled={index === 0}>
            ↑
          </button>
          <button type="button" className="btn ghost sm" onClick={() => moveTo(addon.key, index + 1)} disabled={index === order.length - 1}>
            ↓
          </button>
          <button type="button" className="btn ghost sm" onClick={() => moveTo(addon.key, order.length)} title="Move to bottom (loses every conflict)">
            Bottom
          </button>
        </div>
      </div>
      <div className="drawer-row">
        <span>Always on during crash hunting</span>
        <Toggle on={pins.has(addon.key)} onChange={() => togglePin(addon.key)} label="Always on during crash hunting" />
      </div>

      <div className="btn-group wide">
        {addon.workshopId && (
          <button type="button" className="btn" onClick={() => openUrl(`https://steamcommunity.com/sharedfiles/filedetails/?id=${addon.workshopId}`)}>
            Workshop page
          </button>
        )}
        <button type="button" className="btn" onClick={() => api.reveal(addon.path).catch((e) => notify(errorText(e), "error"))}>
          Show in Explorer
        </button>
      </div>

      {addon.error && <div className="banner bad">Couldn't read this VPK: {addon.error}</div>}
      {stats?.shadowed && <div className="banner warn">Every file in this add-on is overridden by something higher up, so it currently has no effect.</div>}

      {related.length > 0 && (
        <section>
          <h3>Conflicts</h3>
          <ul className="mini-list">
            {related.map((p) => {
              const wins = p.winner === addon.key;
              const other = wins ? p.loser : p.winner;
              return (
                <li key={`${p.winner}|${p.loser}`}>
                  <SeverityPill severity={p.severity} />
                  <span className={wins ? "ok-text" : "bad-text"}>{wins ? "overrides" : "overridden by"}</span>
                  <AddonLink k={other} />
                  <span className="muted small">{plural(p.total - p.identical, "file")}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {reqs.length > 0 && (
        <section>
          <h3>Requires</h3>
          <ul className="mini-list">
            {reqs.map((r) => {
              const key = keyByWorkshopId.get(r.id);
              const state = !key ? "Not subscribed" : enabled.has(key) ? "OK" : "Disabled";
              return (
                <li key={r.id}>
                  <span className={`flag ${state === "OK" ? "ok" : state === "Disabled" ? "warn" : "bad"}`}>{state}</span>
                  {key ? (
                    <AddonLink k={key} />
                  ) : (
                    <button type="button" className="addon-link" onClick={() => openUrl(`https://steamcommunity.com/sharedfiles/filedetails/?id=${r.id}`)}>
                      {r.title || r.id}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {myRules.length > 0 && (
        <section>
          <h3>Your decisions</h3>
          <ul className="mini-list">
            {myRules.map((r) => (
              <li key={`${r.winner}|${r.loser}`}>
                <AddonLink k={r.winner} />
                <span className="muted small">beats</span>
                <AddonLink k={r.loser} />
                <button type="button" className="btn ghost sm" onClick={() => removeRule(r)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {description && (
        <section>
          <h3>Description</h3>
          <p className="description">{description}</p>
        </section>
      )}

      <section>
        <h3>Files</h3>
        {files ? (
          <ul className="file-list tall">
            {files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        ) : (
          <button type="button" className="btn ghost" onClick={() => api.addonFiles(addon.key).then(setFiles)}>
            Show {addon.fileCount} files
          </button>
        )}
      </section>
      <p className="muted small mono">{addon.key}</p>
    </aside>
  );
}
