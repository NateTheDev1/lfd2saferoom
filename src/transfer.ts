import type { Addon, Rule } from "./api";

export const ARRANGE_OPTIONS_KEY = "saferoom.arrange-options";

export interface Profile {
  name: string;
  created: number;
  order: string[];
  enabled: string[];
}

export interface ExportedAddon {
  key: string;
  workshopId: string | null;
  title: string;
  fileName: string;
  size: number;
}

export interface ConfigExport {
  format: "saferoom-config";
  version: 1;
  exportedAt: number;
  machine: string;
  layout: { order: string[]; enabled: string[] };
  addons: ExportedAddon[];
  profiles: Profile[];
  rules: Rule[];
  pins: string[];
  arrangeOptions: unknown;
}

export interface ImportPlan {
  config: ConfigExport;
  order: string[];
  enabled: string[];
  missing: ExportedAddon[];
  extras: string[];
  matched: number;
}

function readArrangeOptions(): unknown {
  try {
    const raw = localStorage.getItem(ARRANGE_OPTIONS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function buildExport(args: {
  machine: string;
  order: string[];
  enabled: Set<string>;
  addonsByKey: Map<string, Addon>;
  name: (key: string) => string;
  profiles: Profile[];
  rules: Rule[];
  pins: Set<string>;
}): ConfigExport {
  return {
    format: "saferoom-config",
    version: 1,
    exportedAt: Date.now(),
    machine: args.machine,
    layout: { order: args.order, enabled: args.order.filter((k) => args.enabled.has(k)) },
    addons: args.order.flatMap((k) => {
      const a = args.addonsByKey.get(k);
      return a ? [{ key: k, workshopId: a.workshopId, title: args.name(k), fileName: a.fileName, size: a.size }] : [];
    }),
    profiles: args.profiles,
    rules: args.rules,
    pins: [...args.pins],
    arrangeOptions: readArrangeOptions(),
  };
}

function isConfig(value: unknown): value is ConfigExport {
  const v = value as Partial<ConfigExport> | null;
  return !!v && v.format === "saferoom-config" && !!v.layout && Array.isArray(v.layout.order) && Array.isArray(v.layout.enabled);
}

export function planImport(value: unknown, installedOrder: string[], currentlyEnabled: Set<string>): ImportPlan {
  if (!isConfig(value)) throw new Error("That file isn't a Saferoom configuration export");
  const config = value;
  const installed = new Set(installedOrder);
  const listed = new Set(config.layout.order);
  const wanted = new Set(config.layout.enabled);
  const order = config.layout.order.filter((k) => installed.has(k));
  const extras = installedOrder.filter((k) => !listed.has(k));
  const enabled = [...order.filter((k) => wanted.has(k)), ...extras.filter((k) => currentlyEnabled.has(k))];
  const missing = (config.addons ?? []).filter((a) => !installed.has(a.key));
  return { config, order: [...order, ...extras], enabled, missing, extras, matched: order.length };
}

export function mergeProfiles(current: Profile[], incoming: Profile[]): Profile[] {
  const names = new Set(incoming.map((p) => p.name));
  return [...incoming, ...current.filter((p) => !names.has(p.name))];
}

export function mergeRules(current: Rule[], incoming: Rule[]): Rule[] {
  const pairKey = (r: Rule) => [r.winner, r.loser].sort().join("|");
  const incomingPairs = new Set(incoming.map(pairKey));
  return [...current.filter((r) => !incomingPairs.has(pairKey(r))), ...incoming];
}

export function applyArrangeOptions(options: unknown) {
  if (!options) return;
  try {
    localStorage.setItem(ARRANGE_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    /* storage unavailable */
  }
}
