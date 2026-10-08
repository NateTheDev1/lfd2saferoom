import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorText, STALE_PREFIX, type Addon, type Analysis, type Requirement, type Rule, type WorkshopInfo } from "./api";

export type View = "order" | "arrange" | "conflicts" | "log" | "hunter" | "profiles" | "backups";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}

export interface Layout {
  order: string[];
  enabled: Set<string>;
}

interface History {
  past: Layout[];
  present: Layout;
  future: Layout[];
}

export interface RequirementIssue {
  requirement: Requirement;
  state: "missing" | "disabled";
  key: string | null;
}

export interface RequirementStatus {
  checked: number;
  total: number;
  running: boolean;
  rateLimited: boolean;
}

const EMPTY: Layout = { order: [], enabled: new Set() };
const REQUIREMENT_BATCH = 8;
const REQUIREMENT_RETRY_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 100;

export function sameLayout(a: Layout, b: Layout) {
  if (a.order.length !== b.order.length || a.enabled.size !== b.enabled.size) return false;
  if (a.order.some((k, i) => k !== b.order[i])) return false;
  for (const k of a.enabled) if (!b.enabled.has(k)) return false;
  return true;
}

function useStoreValue() {
  const [gameDir, setGameDir] = useState<string | null>(null);
  const [addonsByKey, setAddonsByKey] = useState<Map<string, Addon>>(new Map());
  const [history, setHistory] = useState<History>({ past: [], present: EMPTY, future: [] });
  const [baseline, setBaseline] = useState<Layout>(EMPTY);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [baselineAnalysis, setBaselineAnalysis] = useState<Analysis | null>(null);
  const [workshop, setWorkshop] = useState<Record<string, WorkshopInfo>>({});
  const [requirements, setRequirements] = useState<Record<string, Requirement[]>>({});
  const [requirementStatus, setRequirementStatus] = useState<RequirementStatus>({ checked: 0, total: 0, running: false, rateLimited: false });
  const requirementRun = useRef(0);
  const [gameRunning, setGameRunning] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [view, setView] = useState<View>("order");
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [staleSave, setStaleSave] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const layout = history.present;
  const dirty = useMemo(() => !sameLayout(layout, baseline), [layout, baseline]);

  const notify = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  const commit = useCallback((update: (l: Layout) => Layout) => {
    setHistory((h) => {
      const next = update(h.present);
      if (next === h.present || sameLayout(next, h.present)) return h;
      return { past: [...h.past.slice(-HISTORY_LIMIT + 1), h.present], present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h));
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));
  }, []);

  const checkRequirements = useCallback(async function check(ids: string[]): Promise<void> {
    const run = ++requirementRun.current;
    setRequirementStatus({ checked: 0, total: ids.length, running: true, rateLimited: false });
    for (let i = 0; i < ids.length; i += REQUIREMENT_BATCH) {
      try {
        const batch = await api.workshopRequirements(ids.slice(i, i + REQUIREMENT_BATCH));
        if (run !== requirementRun.current) return;
        setRequirements((r) => ({ ...r, ...batch.items }));
        const checked = Math.min(ids.length, i + REQUIREMENT_BATCH);
        if (batch.rateLimited) {
          setRequirementStatus({ checked: i, total: ids.length, running: false, rateLimited: true });
          setTimeout(() => run === requirementRun.current && check(ids), REQUIREMENT_RETRY_MS);
          return;
        }
        setRequirementStatus({ checked, total: ids.length, running: checked < ids.length, rateLimited: false });
      } catch {
        if (run === requirementRun.current) setRequirementStatus((s) => ({ ...s, running: false }));
        return;
      }
    }
  }, []);

  const loadScan = useCallback(
    async (dir?: string): Promise<Layout | null> => {
      setScanning(true);
      setScanError(null);
      try {
        const result = await api.scan(dir);
        const next = { order: result.addons.map((a) => a.key), enabled: new Set(result.addons.filter((a) => a.enabled).map((a) => a.key)) };
        setGameDir(result.gameDir);
        setAddonsByKey(new Map(result.addons.map((a) => [a.key, a])));
        setBaseline(next);
        setExternalChange(false);
        const ids = result.addons.flatMap((a) => (a.workshopId ? [a.workshopId] : []));
        if (ids.length) {
          api
            .workshopDetails(ids)
            .then(setWorkshop)
            .catch(() => notify("Couldn't reach Steam for workshop titles, using local info", "info"));
          const enabledFirst = [...result.addons].sort((x, y) => Number(y.enabled) - Number(x.enabled)).flatMap((a) => (a.workshopId ? [a.workshopId] : []));
          checkRequirements(enabledFirst);
        }
        return next;
      } catch (e) {
        setScanError(errorText(e));
        return null;
      } finally {
        setScanning(false);
      }
    },
    [notify, checkRequirements],
  );

  const rescan = useCallback(
    async (dir?: string) => {
      const next = await loadScan(dir);
      if (next) setHistory({ past: [], present: next, future: [] });
    },
    [loadScan],
  );

  const rescanKeepingEdits = useCallback(async () => {
    const pending = layout;
    const before = baseline;
    const next = await loadScan(gameDir ?? undefined);
    if (!next) return;
    const enabled = new Set(next.enabled);
    pending.enabled.forEach((k) => !before.enabled.has(k) && enabled.add(k));
    before.enabled.forEach((k) => !pending.enabled.has(k) && enabled.delete(k));
    const orderChanged = pending.order.some((k, i) => k !== before.order[i]);
    const known = new Set(next.order);
    const order = orderChanged ? pending.order.filter((k) => known.has(k)) : [...next.order];
    next.order.forEach((k) => !order.includes(k) && order.push(k));
    setHistory((h) => ({ past: [...h.past, h.present], present: { order, enabled: new Set([...enabled].filter((k) => known.has(k))) }, future: [] }));
    setStaleSave(false);
    notify("Rescanned. Your unsaved edits were reapplied on top.", "success");
  }, [layout, baseline, gameDir, loadScan, notify]);

  useEffect(() => {
    rescan();
    api.storeGet<Rule[]>("rules").then((r) => setRules(r ?? [])).catch(() => {});
    api.storeGet<string[]>("pins").then((p) => setPins(new Set(p ?? []))).catch(() => {});
  }, [rescan]);

  const pollStatus = useCallback(() => {
    api
      .status()
      .then((s) => {
        setGameRunning(s.gameRunning);
        setExternalChange(s.externalChange);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    pollStatus();
    const t = setInterval(pollStatus, 3000);
    window.addEventListener("focus", pollStatus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", pollStatus);
    };
  }, [pollStatus]);

  useEffect(() => {
    if (!externalChange || dirty || scanning || gameRunning) return;
    rescan(gameDir ?? undefined).then(() => notify("Picked up changes made by Steam or the game", "info"));
  }, [externalChange, dirty, scanning, gameRunning, gameDir, rescan, notify]);

  useEffect(() => {
    if (!addonsByKey.size) return;
    const handle = setTimeout(() => {
      api.analyze(layout.order, [...layout.enabled]).then(setAnalysis).catch((e) => notify(errorText(e), "error"));
    }, 120);
    return () => clearTimeout(handle);
  }, [layout, addonsByKey, notify]);

  useEffect(() => {
    if (!addonsByKey.size) return;
    api.analyze(baseline.order, [...baseline.enabled]).then(setBaselineAnalysis).catch(() => {});
  }, [baseline, addonsByKey]);

  const name = useCallback(
    (key: string) => {
      const a = addonsByKey.get(key);
      if (!a) return key;
      return (a.workshopId && workshop[a.workshopId]?.title) || a.title || a.fileName;
    },
    [addonsByKey, workshop],
  );

  const setEnabled = useCallback(
    (keys: string[], on: boolean) =>
      commit((l) => {
        const enabled = new Set(l.enabled);
        keys.forEach((k) => (on ? enabled.add(k) : enabled.delete(k)));
        return { ...l, enabled };
      }),
    [commit],
  );

  const toggle = useCallback(
    (key: string) =>
      commit((l) => {
        const enabled = new Set(l.enabled);
        if (enabled.has(key)) enabled.delete(key);
        else enabled.add(key);
        return { ...l, enabled };
      }),
    [commit],
  );

  const moveTo = useCallback(
    (key: string, index: number) =>
      commit((l) => {
        const order = l.order.filter((k) => k !== key);
        order.splice(Math.max(0, Math.min(index, order.length)), 0, key);
        return { ...l, order };
      }),
    [commit],
  );

  const placeAbove = useCallback(
    (key: string, target: string) =>
      commit((l) => {
        if (l.order.indexOf(key) < l.order.indexOf(target)) return l;
        const order = l.order.filter((k) => k !== key);
        order.splice(order.indexOf(target), 0, key);
        return { ...l, order };
      }),
    [commit],
  );

  const applyLayout = useCallback(
    (order: string[], enabled: Iterable<string>) => {
      const known = new Set(addonsByKey.keys());
      commit((l) => {
        const seen = new Set<string>();
        const nextOrder = order.filter((k) => known.has(k) && !seen.has(k) && seen.add(k));
        l.order.forEach((k) => !seen.has(k) && nextOrder.push(k));
        return { order: nextOrder, enabled: new Set([...enabled].filter((k) => known.has(k))) };
      });
    },
    [addonsByKey, commit],
  );

  const writeLayout = useCallback(
    async (order: string[], enabled: Set<string>, force = false) => {
      const backup = await api.save(order, [...enabled], force);
      const next = { order, enabled: new Set(enabled) };
      commit(() => next);
      setBaseline(next);
      setExternalChange(false);
      return backup;
    },
    [commit],
  );

  const confirmSave = useCallback(
    async (force = false) => {
      try {
        await writeLayout(layout.order, layout.enabled, force);
        setReviewOpen(false);
        setStaleSave(false);
        notify("Saved addonlist.txt (previous version backed up)", "success");
      } catch (e) {
        const msg = errorText(e);
        if (msg.startsWith(STALE_PREFIX)) setStaleSave(true);
        else notify(msg, "error");
      }
    },
    [layout, writeLayout, notify],
  );

  const requestSave = useCallback(() => {
    if (dirty && !gameRunning) setReviewOpen(true);
  }, [dirty, gameRunning]);

  const discard = useCallback(() => commit(() => baseline), [baseline, commit]);

  const persistRules = useCallback(
    (next: Rule[]) => {
      setRules(next);
      api.storeSet("rules", next).catch((e) => notify(errorText(e), "error"));
    },
    [notify],
  );

  const addRule = useCallback(
    (winner: string, loser: string) => {
      setRules((current) => {
        const next = [...current.filter((r) => !((r.winner === winner && r.loser === loser) || (r.winner === loser && r.loser === winner))), { winner, loser }];
        api.storeSet("rules", next).catch((e) => notify(errorText(e), "error"));
        return next;
      });
    },
    [notify],
  );

  const replaceRules = useCallback((next: Rule[]) => persistRules(next), [persistRules]);

  const replacePins = useCallback(
    (next: Set<string>) => {
      setPins(next);
      api.storeSet("pins", [...next]).catch((e) => notify(errorText(e), "error"));
    },
    [notify],
  );

  const removeRule = useCallback((rule: Rule) => persistRules(rules.filter((r) => r !== rule)), [rules, persistRules]);

  const preferOver = useCallback(
    (winner: string, losers: string[]) => {
      losers.forEach((l) => addRule(winner, l));
      commit((l) => {
        const above = losers.map((k) => l.order.indexOf(k)).filter((i) => i >= 0);
        const top = Math.min(...above);
        const at = l.order.indexOf(winner);
        if (!above.length || at < top) return l;
        const order = l.order.filter((k) => k !== winner);
        order.splice(top, 0, winner);
        return { ...l, order };
      });
    },
    [addRule, commit],
  );

  const togglePin = useCallback(
    (key: string) => {
      setPins((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        api.storeSet("pins", [...next]).catch((e) => notify(errorText(e), "error"));
        return next;
      });
    },
    [notify],
  );

  const addons = useMemo(() => layout.order.map((k) => addonsByKey.get(k)).filter((a): a is Addon => !!a), [layout.order, addonsByKey]);

  const keyByWorkshopId = useMemo(() => {
    const m = new Map<string, string>();
    addonsByKey.forEach((a) => a.workshopId && m.set(a.workshopId, a.key));
    return m;
  }, [addonsByKey]);

  const requirementIssues = useMemo(() => {
    const out: Record<string, RequirementIssue[]> = {};
    for (const a of addonsByKey.values()) {
      if (!a.workshopId || !layout.enabled.has(a.key)) continue;
      const issues = (requirements[a.workshopId] ?? []).flatMap((requirement): RequirementIssue[] => {
        const key = keyByWorkshopId.get(requirement.id) ?? null;
        if (!key) return [{ requirement, state: "missing", key: null }];
        return layout.enabled.has(key) ? [] : [{ requirement, state: "disabled", key }];
      });
      if (issues.length) out[a.key] = issues;
    }
    return out;
  }, [addonsByKey, layout.enabled, requirements, keyByWorkshopId]);

  const libraries = useMemo(() => {
    const libs = new Set<string>();
    for (const a of addonsByKey.values()) {
      if (!a.workshopId) continue;
      for (const r of requirements[a.workshopId] ?? []) {
        const key = keyByWorkshopId.get(r.id);
        if (key) libs.add(key);
      }
    }
    return libs;
  }, [addonsByKey, requirements, keyByWorkshopId]);

  const enabledSize = useMemo(() => addons.reduce((sum, a) => sum + (layout.enabled.has(a.key) ? a.size : 0), 0), [addons, layout.enabled]);

  return {
    gameDir,
    addons,
    addonsByKey,
    order: layout.order,
    enabled: layout.enabled,
    layout,
    baseline,
    dirty,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    analysis,
    baselineAnalysis,
    workshop,
    requirements,
    requirementStatus,
    requirementIssues,
    libraries,
    keyByWorkshopId,
    enabledSize,
    gameRunning,
    externalChange,
    scanning,
    scanError,
    view,
    setView,
    selected,
    setSelected,
    reviewOpen,
    setReviewOpen,
    staleSave,
    setStaleSave,
    rules,
    pins,
    toasts,
    notify,
    rescan,
    rescanKeepingEdits,
    name,
    toggle,
    setEnabled,
    moveTo,
    placeAbove,
    applyLayout,
    writeLayout,
    requestSave,
    confirmSave,
    discard,
    undo,
    redo,
    addRule,
    removeRule,
    replaceRules,
    replacePins,
    preferOver,
    togglePin,
  };
}

export type Store = ReturnType<typeof useStoreValue>;

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreValue();
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore outside provider");
  return s;
}
