import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import type { Addon, Severity } from "../api";
import { useStore } from "../store";

export function Thumb({ addon, size = 44 }: { addon: Addon; size?: number }) {
  const { workshop, name } = useStore();
  const [failed, setFailed] = useState(false);
  const remote = addon.workshopId ? workshop[addon.workshopId]?.previewUrl : null;
  const src = !failed && addon.thumbnail ? convertFileSrc(addon.thumbnail) : remote;
  const initials = name(addon.key)
    .replace(/[^a-z0-9 ]/gi, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div className="thumb" style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span>{initials || "?"}</span>}
    </div>
  );
}

const severityLabel: Record<Severity, string> = {
  harmless: "Harmless",
  low: "Cosmetic",
  medium: "Notable",
  high: "Breaking",
};

export function SeverityPill({ severity }: { severity: Severity }) {
  return <span className={`pill sev-${severity}`}>{severityLabel[severity]}</span>;
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? "on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
    >
      <span />
    </button>
  );
}

export function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ms: number) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function categoryLabel(cat: string) {
  return (
    {
      vscript: "VScripts",
      talker: "Talker",
      script: "Scripts",
      mission: "Missions",
      map: "Maps",
      ui: "UI",
      particle: "Particles",
      model: "Models",
      material: "Textures",
      sound: "Sounds",
      other: "Other",
    } as Record<string, string>
  )[cat] ?? cat;
}

export function AddonLink({ k }: { k: string }) {
  const { name, setSelected } = useStore();
  return (
    <button
      type="button"
      className="addon-link"
      onClick={(e) => {
        e.stopPropagation();
        setSelected(k);
      }}
    >
      {name(k)}
    </button>
  );
}
