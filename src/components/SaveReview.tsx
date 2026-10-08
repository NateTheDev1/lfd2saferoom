import { useEffect, useMemo } from "react";
import type { Analysis, Pair } from "../api";
import { useStore } from "../store";
import { AddonLink, plural } from "./common";

function dragsNeeded(before: string[], after: string[]) {
  const index = new Map(before.map((k, i) => [k, i]));
  const seq = after.map((k) => index.get(k)).filter((i): i is number => i !== undefined);
  const tails: number[] = [];
  for (const x of seq) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return seq.length - tails.length;
}

const pairId = (p: Pair) => [p.winner, p.loser].sort().join("|");

function diffConflicts(before: Analysis | null, after: Analysis | null) {
  const real = (a: Analysis | null) => new Map((a?.pairs ?? []).filter((p) => p.severity !== "harmless").map((p) => [pairId(p), p]));
  const b = real(before);
  const a = real(after);
  const created = [...a.values()].filter((p) => !b.has(pairId(p)));
  const resolved = [...b.values()].filter((p) => !a.has(pairId(p)));
  const flipped = [...a.values()].filter((p) => b.has(pairId(p)) && b.get(pairId(p))!.winner !== p.winner);
  const brokenBefore = new Set((before?.splitModels ?? []).filter((s) => s.severity === "high").map((s) => s.model));
  const brokenAfter = new Set((after?.splitModels ?? []).filter((s) => s.severity === "high").map((s) => s.model));
  return {
    created,
    resolved,
    flipped,
    modelsBroken: [...brokenAfter].filter((m) => !brokenBefore.has(m)),
    modelsFixed: [...brokenBefore].filter((m) => !brokenAfter.has(m)),
  };
}

export function SaveReview() {
  const { reviewOpen, setReviewOpen, layout, baseline, analysis, baselineAnalysis, confirmSave, staleSave, setStaleSave, rescanKeepingEdits, gameRunning, requirementIssues } =
    useStore();

  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setReviewOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewOpen, setReviewOpen]);

  const diff = useMemo(() => {
    const turnedOn = layout.order.filter((k) => layout.enabled.has(k) && !baseline.enabled.has(k));
    const turnedOff = layout.order.filter((k) => !layout.enabled.has(k) && baseline.enabled.has(k));
    return { turnedOn, turnedOff, drags: dragsNeeded(baseline.order, layout.order), ...diffConflicts(baselineAnalysis, analysis) };
  }, [layout, baseline, analysis, baselineAnalysis]);

  if (!reviewOpen) return null;
  const close = () => {
    setReviewOpen(false);
    setStaleSave(false);
  };
  const missingReqs = Object.keys(requirementIssues).length;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="review-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="review-title">Review changes</h2>

        {staleSave ? (
          <div className="banner warn">
            <strong>addonlist.txt changed since the last scan.</strong> Steam or the game updated it, so saving now would throw those changes away.
            <div className="card-actions">
              <button type="button" className="btn primary" onClick={rescanKeepingEdits}>
                Rescan and keep my edits
              </button>
              <button type="button" className="btn danger" onClick={() => confirmSave(true)}>
                Overwrite anyway
              </button>
            </div>
          </div>
        ) : null}

        <div className="review-grid">
          <ReviewStat value={diff.turnedOn.length} label="enabled" />
          <ReviewStat value={diff.turnedOff.length} label="disabled" />
          <ReviewStat value={diff.drags} label="moved" />
          <ReviewStat value={diff.resolved.length + diff.modelsFixed.length} label="conflicts fixed" tone="ok" />
          <ReviewStat value={diff.created.length + diff.modelsBroken.length} label="new conflicts" tone={diff.created.length + diff.modelsBroken.length ? "bad" : undefined} />
        </div>

        <div className="review-body">
          <KeyList title="Enabled" keys={diff.turnedOn} />
          <KeyList title="Disabled" keys={diff.turnedOff} />
          {diff.modelsBroken.length > 0 && (
            <ReviewSection title="Models that break">
              {diff.modelsBroken.map((m) => (
                <li key={m}>
                  <code>{m}</code>
                </li>
              ))}
            </ReviewSection>
          )}
          <PairList title="New conflicts" pairs={diff.created} />
          <PairList title="Now won by the other add-on" pairs={diff.flipped} />
          <PairList title="Conflicts that go away" pairs={diff.resolved} />
          {diff.modelsFixed.length > 0 && (
            <ReviewSection title="Models fixed">
              {diff.modelsFixed.map((m) => (
                <li key={m}>
                  <code>{m}</code>
                </li>
              ))}
            </ReviewSection>
          )}
          {missingReqs > 0 && (
            <p className="banner warn">
              {missingReqs} enabled add-on{missingReqs === 1 ? " is" : "s are"} missing a required item. See Conflicts → Requirements.
            </p>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={gameRunning || staleSave} onClick={() => confirmSave(false)}>
            {gameRunning ? "Close L4D2 to save" : "Save addonlist.txt"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewStat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className={`review-stat ${value && tone ? `tone-${tone}` : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      <ul className="mini-list">{children}</ul>
    </section>
  );
}

function KeyList({ title, keys }: { title: string; keys: string[] }) {
  if (!keys.length) return null;
  return (
    <ReviewSection title={`${title} (${keys.length})`}>
      {keys.slice(0, 30).map((k) => (
        <li key={k}>
          <AddonLink k={k} />
        </li>
      ))}
      {keys.length > 30 && <li className="muted small">…and {keys.length - 30} more</li>}
    </ReviewSection>
  );
}

function PairList({ title, pairs }: { title: string; pairs: Pair[] }) {
  if (!pairs.length) return null;
  return (
    <ReviewSection title={`${title} (${pairs.length})`}>
      {pairs.slice(0, 20).map((p) => (
        <li key={pairId(p)}>
          <AddonLink k={p.winner} />
          <span className="muted small">over</span>
          <AddonLink k={p.loser} />
          <span className="muted small">· {plural(p.total - p.identical, "file")}</span>
        </li>
      ))}
      {pairs.length > 20 && <li className="muted small">…and {pairs.length - 20} more</li>}
    </ReviewSection>
  );
}
