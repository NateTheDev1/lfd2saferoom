import { useEffect, useState } from "react";
import { api, errorText, type ArrangeOptions, type Change, type Plan, type Summary, type Unresolved } from "../api";
import { useStore } from "../store";
import { ARRANGE_OPTIONS_KEY } from "../transfer";
import { AddonLink, plural } from "./common";


function loadOptions(): ArrangeOptions {
  try {
    const raw = localStorage.getItem(ARRANGE_OPTIONS_KEY);
    if (raw) return { fixModels: true, preferSpecific: true, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { fixModels: true, preferSpecific: true };
}

const summaryRows: { key: keyof Summary; label: string; tone: string }[] = [
  { key: "breaking", label: "Breaking", tone: "bad" },
  { key: "splitModels", label: "Broken models", tone: "bad" },
  { key: "notable", label: "Notable", tone: "warn" },
  { key: "cosmetic", label: "Cosmetic", tone: "muted" },
  { key: "shadowed", label: "Fully overridden", tone: "warn" },
];

export function Arrange() {
  const { order, enabled, rules, applyLayout, notify, removeRule, name, setView } = useStore();
  const [options, setOptions] = useState<ArrangeOptions>(loadOptions);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(ARRANGE_OPTIONS_KEY, JSON.stringify(options));
    } catch {
      /* storage unavailable */
    }
  }, [options]);

  useEffect(() => {
    if (!order.length) return;
    let alive = true;
    setBusy(true);
    const handle = setTimeout(() => {
      api
        .arrange(order, [...enabled], rules, options)
        .then((p) => alive && setPlan(p))
        .catch((e) => notify(errorText(e), "error"))
        .finally(() => alive && setBusy(false));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [order, enabled, rules, options, notify]);

  const apply = () => {
    if (!plan) return;
    applyLayout(plan.order, enabled);
    notify(`Arranged. ${plural(plan.moved, "add-on")} moved. Review, then Save.`, "success");
  };

  const grouped = (reason: Change["reason"]) => plan?.changes.filter((c) => c.reason === reason) ?? [];
  const arranged = plan && plan.moved === 0;

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Auto-arrange</h1>
          <p className="muted">
            Finds the load order that fixes broken models, lets specific mods beat the big packs they overlap with, and keeps every decision you've made.
            Add-ons that don't conflict keep their place, so the change is as small as possible.
          </p>
        </div>
      </header>

      <div className="panel arrange-controls">
        <label className="check">
          <input type="checkbox" checked={options.fixModels} onChange={(e) => setOptions({ ...options, fixModels: e.target.checked })} />
          <span>
            <strong>Fix broken models</strong>
            <span className="muted small">One add-on supplies every core file of a model (.mdl, .vvd, .vtx)</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={options.preferSpecific} onChange={(e) => setOptions({ ...options, preferSpecific: e.target.checked })} />
          <span>
            <strong>Specific mods beat big packs</strong>
            <span className="muted small">A 4-file gas can skin wins over a 5,000-file texture overhaul where they overlap</span>
          </span>
        </label>
      </div>

      {plan && (
        <>
          <div className="before-after">
            {summaryRows.map((r) => {
              const before = plan.before[r.key];
              const after = plan.after[r.key];
              const delta = after - before;
              return (
                <div key={r.key} className={`stat tone-${after ? r.tone : "muted"}`}>
                  <strong>
                    {after}
                    {delta !== 0 && <em className={delta < 0 ? "ok-text" : "bad-text"}>{delta > 0 ? `+${delta}` : delta}</em>}
                  </strong>
                  <span>{r.label}</span>
                </div>
              );
            })}
          </div>

          <div className={`panel apply-bar ${arranged ? "done" : ""}`}>
            {arranged ? (
              <span>
                <strong>Already arranged.</strong> <span className="muted">Nothing needs to move with these settings.</span>
              </span>
            ) : (
              <>
                <span>
                  <strong>{plural(plan.moved, "add-on")} to move</strong>{" "}
                  <span className="muted">
                    · {plural(plan.changes.length, "reordering")} below{busy ? " · updating…" : ""}
                  </span>
                </span>
                <button type="button" className="btn primary" onClick={apply} disabled={busy}>
                  Apply arrangement
                </button>
              </>
            )}
          </div>

          <ChangeGroup title="Model fixes" changes={grouped("model")} />
          <ChangeGroup title="Specific beats pack" changes={grouped("specific")} />
          <ChangeGroup title="Your decisions" changes={grouped("rule")} />

          {plan.unresolved.length > 0 && (
            <section>
              <h3>Needs your call ({plan.unresolved.length})</h3>
              <p className="hint">Reordering can't fix these. Pick which add-on to keep.</p>
              <div className="cards">
                {plan.unresolved.map((u, i) => (
                  <UnresolvedCard key={`${u.kind}-${i}`} item={u} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <section>
        <h3>Your decisions ({rules.length})</h3>
        <p className="hint">
          Made with “Let X win” and “Use X” in{" "}
          <button type="button" className="inline-link" onClick={() => setView("conflicts")}>
            Conflicts
          </button>
          , or “Keep current” above. Auto-arrange always respects these.
        </p>
        {rules.length ? (
          <ul className="mini-list rules">
            {rules.map((r) => (
              <li key={`${r.winner}|${r.loser}`}>
                <AddonLink k={r.winner} />
                <span className="muted small">beats</span>
                <AddonLink k={r.loser} />
                <button type="button" className="btn ghost sm" aria-label={`Forget ${name(r.winner)} beats ${name(r.loser)}`} onClick={() => removeRule(r)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None yet.</p>
        )}
      </section>
    </section>
  );
}

function reasonText(c: Change) {
  if (c.reason === "model") return `so ${c.model?.split("/").pop()} comes from one add-on`;
  if (c.reason === "specific") return `${plural(c.winnerFiles, "file")} vs ${c.loserFiles.toLocaleString()}`;
  return "your decision";
}

function ChangeGroup({ title, changes }: { title: string; changes: Change[] }) {
  const { addRule } = useStore();
  if (!changes.length) return null;
  return (
    <section>
      <h3>
        {title} ({changes.length})
      </h3>
      <ul className="change-list">
        {changes.map((c) => (
          <li key={`${c.winner}|${c.loser}`}>
            <div className="versus">
              <AddonLink k={c.winner} />
              <span className="beats">will now beat</span>
              <AddonLink k={c.loser} />
            </div>
            <span className="muted small">{reasonText(c)}</span>
            {c.reason !== "rule" && (
              <button type="button" className="btn ghost sm" title="Remember that the current winner should stay on top" onClick={() => addRule(c.loser, c.winner)}>
                Keep current
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function UnresolvedCard({ item }: { item: Unresolved }) {
  const { setEnabled, name } = useStore();
  const label = { blocked: "Blocked", model: "Broken model", script: "Script clash", duplicate: "Duplicate" }[item.kind];
  return (
    <article className={`card ${item.kind === "duplicate" ? "sev-border-medium" : "sev-border-high"}`}>
      <div className="card-head static">
        <div className="versus">
          <span className={`pill ${item.kind === "duplicate" ? "sev-medium" : "sev-high"}`}>{label}</span>
          {item.keys.map((k, i) => (
            <span key={k} className="versus-item">
              {i > 0 && <span className="beats">&amp;</span>}
              <AddonLink k={k} />
            </span>
          ))}
        </div>
      </div>
      <p className="muted small">{item.detail}</p>
      {item.kind !== "blocked" && (
        <div className="card-actions">
          {item.keys.map((k) => (
            <button type="button" key={k} className="btn ghost" onClick={() => setEnabled([k], false)}>
              Disable “{name(k)}”
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
