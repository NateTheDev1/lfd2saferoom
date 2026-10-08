import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useStore } from "../store";
import { AddonLink, Thumb } from "./common";

interface Hunt {
  snapshot: { order: string[]; enabled: string[] };
  pinned?: string[];
  candidates: string[];
  testing: string[];
  step: number;
  culprit: string | null;
}

const STORAGE_KEY = "saferoom.hunt";

function loadHunt(): Hunt | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Hunt) : null;
  } catch {
    return null;
  }
}

function persist(h: Hunt | null) {
  try {
    if (h) localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

const half = (keys: string[]) => keys.slice(0, Math.ceil(keys.length / 2));

export function CrashHunter() {
  const { order, enabled, dirty, writeLayout, notify, gameRunning, addonsByKey, pins } = useStore();
  const [hunt, setHunt] = useState<Hunt | null>(loadHunt);
  const [busy, setBusy] = useState(false);
  const pinnedNow = order.filter((k) => enabled.has(k) && pins.has(k));
  const roundLayout = (h: Hunt, testing: string[]) => ({ order: h.snapshot.order, enabled: [...(h.pinned ?? []), ...testing] });

  useEffect(() => persist(hunt), [hunt]);

  const run = async (next: Hunt | null, layout: { order: string[]; enabled: Iterable<string> }) => {
    setBusy(true);
    try {
      await writeLayout(layout.order, new Set(layout.enabled), true);
      setHunt(next);
      return true;
    } catch (e) {
      notify(errorText(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    const pinned = new Set(pinnedNow);
    const candidates = order.filter((k) => enabled.has(k) && !pinned.has(k));
    if (candidates.length < 2) return notify("Need at least two add-ons that aren't always-on to hunt through.", "error");
    const next: Hunt = { snapshot: { order, enabled: [...enabled] }, pinned: pinnedNow, candidates, testing: half(candidates), step: 1, culprit: null };
    run(next, roundLayout(next, next.testing));
  };

  const answer = (stillBroken: boolean) => {
    if (!hunt) return;
    const tested = new Set(hunt.testing);
    const remaining = stillBroken ? hunt.testing : hunt.candidates.filter((k) => !tested.has(k));
    if (remaining.length === 0) {
      return notify("That contradicts an earlier answer, so the problem may not come from a single add-on. Restore and try again.", "error");
    }
    if (remaining.length === 1) {
      return run({ ...hunt, candidates: remaining, testing: [], culprit: remaining[0] }, { order: hunt.snapshot.order, enabled: hunt.snapshot.enabled });
    }
    const testing = half(remaining);
    run({ ...hunt, candidates: remaining, testing, step: hunt.step + 1 }, roundLayout(hunt, testing));
  };

  const finish = async (disableCulprit: boolean) => {
    if (!hunt) return;
    const enabledKeys = hunt.snapshot.enabled.filter((k) => !(disableCulprit && k === hunt.culprit));
    const ok = await run(null, { order: hunt.snapshot.order, enabled: enabledKeys });
    if (ok) notify(disableCulprit ? "Restored your setup with the culprit disabled" : "Restored your original setup", "success");
  };

  const stepsLeft = hunt ? Math.ceil(Math.log2(Math.max(hunt.candidates.length, 1))) : 0;

  return (
    <section className="view narrow">
      <header className="view-head">
        <div>
          <h1>Crash hunter</h1>
          <p className="muted">
            Something crashes, errors out or looks wrong and you don't know which add-on is responsible. This splits your enabled add-ons in half each
            round, so 140 add-ons take about 8 test launches.
          </p>
        </div>
      </header>

      {gameRunning && <div className="banner warn">Close Left 4 Dead 2 before answering. Saferoom can't edit the add-on list while the game is running.</div>}

      {!hunt && (
        <div className="panel">
          <ol className="steps">
            <li>Your current setup is remembered and restored at the end.</li>
            <li>Saferoom enables half of your add-ons. Launch the game and try to reproduce the problem.</li>
            <li>Close the game and say whether it still happened. Repeat until one add-on is left.</li>
          </ol>
          <PinPicker />
          {dirty && <p className="hint">Save or discard your pending changes first.</p>}
          <button type="button" className="btn primary" disabled={dirty || busy || gameRunning} onClick={start}>
            Start hunting ({enabled.size - pinnedNow.length} suspects)
          </button>
        </div>
      )}

      {hunt && !hunt.culprit && (
        <div className="panel">
          <div className="hunt-progress">
            <span className="big">Round {hunt.step}</span>
            <span className="muted">
              {hunt.candidates.length} suspects left · about {stepsLeft} more round{stepsLeft === 1 ? "" : "s"}
            </span>
          </div>
          <p>
            <strong>{hunt.testing.length}</strong> suspects are enabled right now
            {hunt.pinned?.length ? <>, plus {hunt.pinned.length} always-on</> : null}. Everything else is off. Launch the game and try to trigger the
            problem.
          </p>
          <div className="card-actions">
            <button type="button" className="btn" onClick={() => api.launchGame().catch((e) => notify(errorText(e), "error"))}>
              Launch Left 4 Dead 2
            </button>
          </div>
          <h3>After closing the game, did the problem happen?</h3>
          <div className="card-actions">
            <button type="button" className="btn danger" disabled={busy || gameRunning} onClick={() => answer(true)}>
              Yes, still broken
            </button>
            <button type="button" className="btn ok" disabled={busy || gameRunning} onClick={() => answer(false)}>
              No, works fine
            </button>
            <button type="button" className="btn ghost" disabled={busy || gameRunning} onClick={() => finish(false)}>
              Stop and restore
            </button>
          </div>
          <details>
            <summary>Enabled this round</summary>
            <ul className="mini-list">
              {hunt.testing.map((k) => (
                <li key={k}>
                  <AddonLink k={k} />
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {hunt?.culprit && (
        <div className="panel culprit">
          <p className="muted">Found it. The problem follows this add-on:</p>
          <div className="culprit-card">
            {addonsByKey.get(hunt.culprit) && <Thumb addon={addonsByKey.get(hunt.culprit)!} size={72} />}
            <AddonLink k={hunt.culprit} />
          </div>
          <p className="hint">
            It may also be clashing with another add-on rather than broken on its own. Check its conflicts before unsubscribing.
          </p>
          <div className="card-actions">
            <button type="button" className="btn primary" disabled={busy || gameRunning} onClick={() => finish(true)}>
              Restore setup without it
            </button>
            <button type="button" className="btn ghost" disabled={busy || gameRunning} onClick={() => finish(false)}>
              Restore everything
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PinPicker() {
  const { order, enabled, pins, libraries, togglePin, name } = useStore();
  const [query, setQuery] = useState("");
  const pinned = order.filter((k) => enabled.has(k) && pins.has(k));
  const suggested = order.filter((k) => enabled.has(k) && libraries.has(k) && !pins.has(k));
  const q = query.trim().toLowerCase();
  const matches = q ? order.filter((k) => enabled.has(k) && !pins.has(k) && name(k).toLowerCase().includes(q)).slice(0, 6) : [];

  return (
    <div className="pin-picker">
      <h3>Always on during the hunt</h3>
      <p className="hint">
        Libraries and frameworks other mods need. Keeping them on stops dependent mods from erroring out and getting blamed by mistake.
      </p>
      <div className="chips">
        {pinned.map((k) => (
          <span key={k} className="chip">
            {name(k)}
            <button type="button" aria-label={`Stop keeping ${name(k)} on`} onClick={() => togglePin(k)}>
              ✕
            </button>
          </span>
        ))}
        {!pinned.length && <span className="muted small">Nothing pinned.</span>}
      </div>
      {suggested.length > 0 && (
        <div className="chips">
          <span className="muted small">Required by other mods:</span>
          {suggested.map((k) => (
            <button type="button" key={k} className="chip add" onClick={() => togglePin(k)}>
              + {name(k)}
            </button>
          ))}
          {suggested.length > 1 && (
            <button type="button" className="btn ghost sm" onClick={() => suggested.forEach(togglePin)}>
              Keep all on
            </button>
          )}
        </div>
      )}
      <input className="search" placeholder="Pin another add-on…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {matches.length > 0 && (
        <div className="chips">
          {matches.map((k) => (
            <button
              type="button"
              key={k}
              className="chip add"
              onClick={() => {
                togglePin(k);
                setQuery("");
              }}
            >
              + {name(k)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
