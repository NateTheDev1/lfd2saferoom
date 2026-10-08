import { DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useMemo, useState } from "react";
import type { Addon, AddonStats } from "../api";
import { useStore } from "../store";
import { Thumb, Toggle, formatBytes } from "./common";

type Filter = "all" | "enabled" | "disabled" | "conflicts" | "issues" | "recent";

const RECENT_SECS = 14 * 24 * 60 * 60;

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  { id: "conflicts", label: "Conflicting" },
  { id: "issues", label: "Needs attention" },
  { id: "recent", label: "Updated recently" },
];

function needsAttention(s: AddonStats | undefined) {
  return !!s && (s.shadowed || s.splitModels > 0 || s.worst === "high");
}

export function LoadOrder() {
  const store = useStore();
  const { addons, enabled, analysis, name, moveTo, order, setEnabled, requirementIssues, workshop, enabledSize } = store;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const stats = analysis?.stats ?? {};
  const duplicated = useMemo(() => new Set((analysis?.duplicates ?? []).flatMap((d) => [d.a, d.b])), [analysis]);
  const updatedAt = (a: Addon) => Math.max(a.modified, (a.workshopId && workshop[a.workshopId]?.timeUpdated) || 0);
  const now = Date.now() / 1000;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = addons.filter((a) => {
      const s = stats[a.key];
      if (filter === "enabled" && !enabled.has(a.key)) return false;
      if (filter === "disabled" && enabled.has(a.key)) return false;
      if (filter === "conflicts" && !(s && (s.wins || s.losses))) return false;
      if (filter === "issues" && !(needsAttention(s) || requirementIssues[a.key] || duplicated.has(a.key))) return false;
      if (filter === "recent" && now - updatedAt(a) > RECENT_SECS) return false;
      if (!q) return true;
      return [name(a.key), a.author ?? "", a.workshopId ?? "", a.fileName, a.tags.join(" ")].some((t) => t.toLowerCase().includes(q));
    });
    return filter === "recent" ? [...list].sort((x, y) => updatedAt(y) - updatedAt(x)) : list;
  }, [addons, enabled, filter, query, stats, name, requirementIssues, duplicated, workshop]);

  const sortable = filter === "all" && !query.trim();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    moveTo(String(e.active.id), order.indexOf(String(e.over.id)));
  };

  const visibleKeys = visible.map((a) => a.key);
  const enabledCount = addons.filter((a) => enabled.has(a.key)).length;

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Load order</h1>
          <p className="muted">
            Higher in the list wins when two add-ons ship the same file. Drag to reorder. {enabledCount} of {addons.length} enabled ·{" "}
            {formatBytes(enabledSize)}.
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn ghost" onClick={() => setEnabled(visibleKeys, true)}>
            Enable {sortable ? "all" : "shown"}
          </button>
          <button type="button" className="btn ghost" onClick={() => setEnabled(visibleKeys, false)}>
            Disable {sortable ? "all" : "shown"}
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input className="search" placeholder="Search title, author, workshop ID, tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="segmented">
          {filters.map((f) => (
            <button type="button" key={f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {!sortable && <p className="hint">Clear the search and filter to drag-reorder.{filter === "recent" ? " Sorted by last update." : ""}</p>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visibleKeys} strategy={verticalListSortingStrategy}>
          <ol className="addon-list">
            {visible.map((a) => (
              <Row
                key={a.key}
                addon={a}
                rank={order.indexOf(a.key) + 1}
                stats={stats[a.key]}
                draggable={sortable}
                on={enabled.has(a.key)}
                missingReq={!!requirementIssues[a.key]}
                duplicate={duplicated.has(a.key)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {!visible.length && <p className="empty">Nothing matches.</p>}
    </section>
  );
}

interface RowProps {
  addon: Addon;
  rank: number;
  stats?: AddonStats;
  draggable: boolean;
  on: boolean;
  missingReq: boolean;
  duplicate: boolean;
}

const Row = memo(function Row({ addon, rank, stats, draggable, on, missingReq, duplicate }: RowProps) {
  const { name, toggle, selected, setSelected, workshop, pins } = useStore();
  const removed = addon.workshopId ? workshop[addon.workshopId]?.removed : false;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: addon.key, disabled: !draggable });
  const style = { transform: CSS.Translate.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`addon-row ${on ? "" : "off"} ${isDragging ? "dragging" : ""} ${selected === addon.key ? "selected" : ""}`}
      onClick={() => setSelected(addon.key)}
    >
      <span className={`grip ${draggable ? "" : "disabled"}`} {...attributes} {...listeners} aria-label="Drag to reorder" onClick={(e) => e.stopPropagation()}>
        ⋮⋮
      </span>
      <span className="rank">{rank}</span>
      <Thumb addon={addon} />
      <div className="addon-main">
        <div className="addon-title">{name(addon.key)}</div>
        <div className="addon-sub">
          {addon.author && <span>{addon.author}</span>}
          {addon.tags.slice(0, 3).map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
          {!addon.workshopId && <span className="tag local">Local</span>}
          {pins.has(addon.key) && <span className="tag">Always on</span>}
        </div>
      </div>
      <div className="row-flags">
        {addon.error && <span className="flag bad">Unreadable</span>}
        {removed && <span className="flag bad">Removed from Workshop</span>}
        {on && missingReq && <span className="flag warn">Missing requirement</span>}
        {on && duplicate && <span className="flag warn">Duplicate</span>}
        {on && stats?.splitModels ? <span className="flag bad">Broken model</span> : null}
        {on && stats?.shadowed && <span className="flag warn">Fully overridden</span>}
        {on && stats && stats.losses > 0 && !stats.shadowed && <span className={`flag ${stats.worst === "high" ? "bad" : "warn"}`}>Loses {stats.losses}</span>}
        {on && stats && stats.wins > 0 && <span className="flag ok">Wins {stats.wins}</span>}
      </div>
      <Toggle on={on} onChange={() => toggle(addon.key)} label={`Enable ${name(addon.key)}`} />
    </li>
  );
});
