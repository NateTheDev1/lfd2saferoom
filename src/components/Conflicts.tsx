import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo, useState } from "react";
import { severityRank, type Duplicate, type Pair, type Severity, type SplitModel } from "../api";
import { useStore } from "../store";
import { AddonLink, SeverityPill, categoryLabel, plural } from "./common";

type Section = "pairs" | "models" | "shadowed" | "duplicates" | "requirements";

export function Conflicts() {
  const { analysis, name, requirementIssues } = useStore();
  const [section, setSection] = useState<Section>("pairs");
  const [minSeverity, setMinSeverity] = useState<Severity>("low");
  const [query, setQuery] = useState("");

  const pairs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (analysis?.pairs ?? []).filter(
      (p) =>
        severityRank[p.severity] >= severityRank[minSeverity] &&
        (!q || name(p.winner).toLowerCase().includes(q) || name(p.loser).toLowerCase().includes(q)),
    );
  }, [analysis, minSeverity, query, name]);

  if (!analysis) return <section className="view"><p className="empty">Analyzing…</p></section>;

  const counts = { high: 0, medium: 0, low: 0, harmless: 0 } as Record<Severity, number>;
  analysis.pairs.forEach((p) => counts[p.severity]++);
  const shadowed = Object.entries(analysis.stats).filter(([, s]) => s.shadowed).map(([k]) => k);
  const broken = analysis.splitModels.filter((s) => s.severity === "high");
  const physics = analysis.splitModels.filter((s) => s.severity !== "high");
  const reqCount = Object.values(requirementIssues).reduce((n, list) => n + list.length, 0);

  const tabs: { id: Section; label: string; count: number }[] = [
    { id: "pairs", label: "Overrides", count: analysis.pairs.length },
    { id: "models", label: "Models", count: analysis.splitModels.length },
    { id: "shadowed", label: "Fully overridden", count: shadowed.length },
    { id: "duplicates", label: "Duplicates", count: analysis.duplicates.length },
    { id: "requirements", label: "Requirements", count: reqCount },
  ];

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Conflicts</h1>
          <p className="muted">
            Only enabled add-ons are compared. Files that are byte-identical across add-ons are marked harmless. Fixes you pick here are remembered by
            Auto-arrange.
          </p>
        </div>
      </header>

      <div className="stat-strip">
        <Stat label="Breaking" value={counts.high} tone="bad" hint="Scripts, maps, missions, talker" />
        <Stat label="Notable" value={counts.medium} tone="warn" hint="Models, UI, particles" />
        <Stat label="Cosmetic" value={counts.low} tone="muted" hint="Textures, sounds" />
        <Stat label="Broken models" value={broken.length} tone={broken.length ? "bad" : "muted"} hint="Core model files from different add-ons" />
        <Stat label="Missing requirements" value={reqCount} tone={reqCount ? "warn" : "muted"} hint="Required Workshop items that are off or not subscribed" />
      </div>

      <div className="toolbar">
        <div className="segmented">
          {tabs.map((t) => (
            <button type="button" key={t.id} className={section === t.id ? "active" : ""} onClick={() => setSection(t.id)}>
              {t.label} <em>{t.count}</em>
            </button>
          ))}
        </div>
        {section === "pairs" && (
          <>
            <input className="search" placeholder="Filter by add-on…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)}>
              <option value="high">Breaking only</option>
              <option value="medium">Notable and up</option>
              <option value="low">Hide harmless</option>
              <option value="harmless">Show everything</option>
            </select>
          </>
        )}
      </div>

      {section === "pairs" && (
        <div className="cards">
          {pairs.map((p) => (
            <PairCard key={`${p.winner}|${p.loser}`} pair={p} />
          ))}
          {!pairs.length && <p className="empty">No conflicts at this level. Nice.</p>}
        </div>
      )}

      {section === "models" && (
        <div className="cards">
          <p className="hint">
            A model is assembled from several files. When the .mdl, .vvd and .vtx come from different add-ons you get stretched or invisible models,
            T-poses or crashes. A .phy from another add-on only affects collision.
          </p>
          {broken.map((s) => (
            <SplitCard key={s.model} split={s} />
          ))}
          {physics.map((s) => (
            <SplitCard key={s.model} split={s} />
          ))}
          {!analysis.splitModels.length && <p className="empty">Every model comes from a single add-on.</p>}
        </div>
      )}

      {section === "shadowed" && (
        <div className="cards">
          <p className="hint">Every file in these add-ons is overridden by something higher in the load order, so they currently do nothing.</p>
          {shadowed.map((k) => (
            <ShadowedCard key={k} k={k} />
          ))}
          {!shadowed.length && <p className="empty">Every enabled add-on contributes something.</p>}
        </div>
      )}

      {section === "duplicates" && (
        <div className="cards">
          <p className="hint">Pairs that look like two versions of the same mod, or that replace mostly the same files. Usually you want just one.</p>
          {analysis.duplicates.map((d) => (
            <DuplicateCard key={`${d.a}|${d.b}`} dup={d} />
          ))}
          {!analysis.duplicates.length && <p className="empty">No duplicates found.</p>}
        </div>
      )}

      {section === "requirements" && <Requirements />}
    </section>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: number; tone: string; hint: string }) {
  return (
    <div className={`stat tone-${tone}`} title={hint}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function PairCard({ pair }: { pair: Pair }) {
  const { name, preferOver, setEnabled } = useStore();
  const [open, setOpen] = useState(false);
  const real = pair.total - pair.identical;
  return (
    <article className={`card sev-border-${pair.severity}`}>
      <div className="card-head" onClick={() => setOpen(!open)}>
        <SeverityPill severity={pair.severity} />
        <div className="versus">
          <AddonLink k={pair.winner} />
          <span className="beats">overrides</span>
          <AddonLink k={pair.loser} />
        </div>
        <div className="card-meta">
          {real > 0 && <span>{plural(real, "file")}</span>}
          {pair.identical > 0 && <span className="muted">{pair.identical} identical</span>}
          <span className="chev">{open ? "▾" : "▸"}</span>
        </div>
      </div>
      <div className="cats">
        {Object.entries(pair.categories).map(([c, n]) => (
          <span key={c} className="tag">
            {categoryLabel(c)} {n}
          </span>
        ))}
      </div>
      {open && (
        <>
          <ul className="file-list">
            {pair.files.map((f) => (
              <li key={f.path} className={f.identical ? "identical" : `sev-${f.severity}`}>
                <code>{f.path}</code>
                {f.identical && <span className="muted">identical</span>}
              </li>
            ))}
            {pair.truncated && <li className="muted">…and more</li>}
          </ul>
          <div className="card-actions">
            <button type="button" className="btn" onClick={() => preferOver(pair.loser, [pair.winner])}>
              Let “{name(pair.loser)}” win
            </button>
            <button type="button" className="btn ghost" onClick={() => preferOver(pair.winner, [pair.loser])} title="Remember this so Auto-arrange keeps it">
              Keep “{name(pair.winner)}” on top
            </button>
            <button type="button" className="btn ghost" onClick={() => setEnabled([pair.loser], false)}>
              Disable “{name(pair.loser)}”
            </button>
            <button type="button" className="btn ghost" onClick={() => setEnabled([pair.winner], false)}>
              Disable “{name(pair.winner)}”
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function SplitCard({ split }: { split: SplitModel }) {
  const { name, preferOver } = useStore();
  return (
    <article className={`card sev-border-${split.severity}`}>
      <div className="card-head static">
        <div className="versus">
          <span className={`pill sev-${split.severity}`}>{split.severity === "high" ? "Broken" : "Physics"}</span>
          <code className="model-path">{split.model}</code>
        </div>
      </div>
      <table className="parts">
        <tbody>
          {split.parts.map((p) => (
            <tr key={p.file}>
              <td>
                <code>{p.file.slice(split.model.length)}</code>
              </td>
              <td>
                <AddonLink k={p.winner} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card-actions">
        {split.addons.map((k) => (
          <button type="button" key={k} className="btn" onClick={() => preferOver(k, split.addons.filter((o) => o !== k))}>
            Use “{name(k)}”
          </button>
        ))}
      </div>
    </article>
  );
}

function ShadowedCard({ k }: { k: string }) {
  const { name, setEnabled, analysis } = useStore();
  const by = (analysis?.pairs ?? []).filter((p) => p.loser === k).map((p) => p.winner);
  return (
    <article className="card sev-border-medium">
      <div className="card-head static">
        <AddonLink k={k} />
        <div className="card-meta">
          <button type="button" className="btn ghost" onClick={() => setEnabled([k], false)}>
            Disable
          </button>
        </div>
      </div>
      <p className="muted small">
        Overridden by {by.slice(0, 4).map(name).join(", ")}
        {by.length > 4 ? ` and ${by.length - 4} more` : ""}
      </p>
    </article>
  );
}

function DuplicateCard({ dup }: { dup: Duplicate }) {
  const { name, setEnabled } = useStore();
  return (
    <article className="card sev-border-medium">
      <div className="card-head static">
        <div className="versus">
          <AddonLink k={dup.a} />
          <span className="beats">&amp;</span>
          <AddonLink k={dup.b} />
        </div>
        <span className="muted small">
          {dup.sameTitle ? "Same name · " : ""}
          {plural(dup.shared, "shared file")} ({Math.round(dup.ratio * 100)}% overlap)
        </span>
      </div>
      <div className="card-actions">
        <button type="button" className="btn ghost" onClick={() => setEnabled([dup.a], false)}>
          Keep “{name(dup.b)}” only
        </button>
        <button type="button" className="btn ghost" onClick={() => setEnabled([dup.b], false)}>
          Keep “{name(dup.a)}” only
        </button>
      </div>
    </article>
  );
}

function Requirements() {
  const { requirementIssues, setEnabled, requirements, requirementStatus: status } = useStore();
  const entries = Object.entries(requirementIssues);
  const checked = Object.keys(requirements).length;
  return (
    <div className="cards">
      <p className="hint">
        Read from each add-on's “Required items” on the Workshop, one page at a time and cached for a week. Unsubscribed items need to be subscribed in
        Steam.
      </p>
      {status.running && (
        <p className="banner">
          Checking the Workshop… {status.checked} of {status.total}
        </p>
      )}
      {status.rateLimited && (
        <p className="banner warn">
          Steam Community is refusing requests right now (rate limit).{" "}
          {checked ? `${checked} of ${status.total} add-ons were checked and cached. ` : ""}Saferoom retries every 10 minutes.
        </p>
      )}
      {entries.map(([key, issues]) => (
        <article key={key} className="card sev-border-medium">
          <div className="card-head static">
            <AddonLink k={key} />
            <span className="muted small">needs</span>
          </div>
          <ul className="mini-list">
            {issues.map((i) => (
              <li key={i.requirement.id}>
                <span className={`flag ${i.state === "missing" ? "bad" : "warn"}`}>{i.state === "missing" ? "Not subscribed" : "Disabled"}</span>
                {i.key ? <AddonLink k={i.key} /> : <span>{i.requirement.title || i.requirement.id}</span>}
                {i.state === "disabled" && i.key ? (
                  <button type="button" className="btn ghost sm" onClick={() => setEnabled([i.key!], true)}>
                    Enable
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => openUrl(`https://steamcommunity.com/sharedfiles/filedetails/?id=${i.requirement.id}`)}
                  >
                    Open on Workshop
                  </button>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
      {!entries.length && !status.running && checked > 0 && <p className="empty">Every requirement is installed and enabled.</p>}
    </div>
  );
}
