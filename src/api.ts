import { invoke } from "@tauri-apps/api/core";

export type Severity = "harmless" | "low" | "medium" | "high";

export interface Addon {
  key: string;
  fileName: string;
  path: string;
  workshopId: string | null;
  enabled: boolean;
  listed: boolean;
  title: string;
  author: string | null;
  version: string | null;
  description: string | null;
  tags: string[];
  size: number;
  fileCount: number;
  modified: number;
  thumbnail: string | null;
  error: string | null;
}

export interface ScanResult {
  gameDir: string;
  addons: Addon[];
}

export interface ConflictFile {
  path: string;
  category: string;
  severity: Severity;
  identical: boolean;
}

export interface Pair {
  winner: string;
  loser: string;
  severity: Severity;
  total: number;
  identical: number;
  categories: Record<string, number>;
  files: ConflictFile[];
  truncated: boolean;
}

export interface SplitModel {
  model: string;
  severity: Severity;
  addons: string[];
  parts: { file: string; winner: string }[];
}

export interface AddonStats {
  files: number;
  wins: number;
  losses: number;
  identicalLosses: number;
  shadowed: boolean;
  splitModels: number;
  worst: Severity | null;
}

export interface Duplicate {
  a: string;
  b: string;
  shared: number;
  ratio: number;
  sameTitle: boolean;
}

export interface Analysis {
  pairs: Pair[];
  splitModels: SplitModel[];
  duplicates: Duplicate[];
  stats: Record<string, AddonStats>;
}

export interface Rule {
  winner: string;
  loser: string;
}

export interface ArrangeOptions {
  fixModels: boolean;
  preferSpecific: boolean;
}

export interface Change {
  winner: string;
  loser: string;
  reason: "rule" | "model" | "specific";
  model: string | null;
  winnerFiles: number;
  loserFiles: number;
}

export interface Unresolved {
  kind: "blocked" | "model" | "script" | "duplicate";
  keys: string[];
  detail: string;
}

export interface Summary {
  breaking: number;
  notable: number;
  cosmetic: number;
  splitModels: number;
  shadowed: number;
}

export interface Plan {
  order: string[];
  changes: Change[];
  moved: number;
  unresolved: Unresolved[];
  before: Summary;
  after: Summary;
}

export interface Requirement {
  id: string;
  title: string;
}

export interface LogIssue {
  kind: "crash" | "script" | "model" | "material" | "sound" | "error";
  text: string;
  path: string | null;
  addons: string[];
  count: number;
  lastLine: number;
}

export interface LogReport {
  path: string;
  exists: boolean;
  modified: number;
  size: number;
  lines: number;
  truncated: boolean;
  issues: LogIssue[];
}

export interface Status {
  gameRunning: boolean;
  externalChange: boolean;
}

export interface WorkshopInfo {
  title: string;
  previewUrl: string | null;
  description: string | null;
  tags: string[];
  timeUpdated: number;
  removed: boolean;
}

export interface Backup {
  name: string;
  created: number;
  entries: number;
  enabled: number;
}

export const api = {
  scan: (gameDir?: string) => invoke<ScanResult>("scan", { gameDir: gameDir ?? null }),
  analyze: (order: string[], enabled: string[]) => invoke<Analysis>("analyze", { order, enabled }),
  addonFiles: (key: string) => invoke<string[]>("addon_files", { key }),
  save: (order: string[], enabled: string[], force = false) => invoke<string | null>("save_addonlist", { order, enabled, force }),
  status: () => invoke<Status>("status"),
  arrange: (order: string[], enabled: string[], rules: Rule[], options: ArrangeOptions) => invoke<Plan>("arrange", { order, enabled, rules, options }),
  launchGame: (condebug = false) => invoke<void>("launch_game", { condebug }),
  readConsoleLog: () => invoke<LogReport>("read_console_log"),
  archiveConsoleLog: () => invoke<void>("archive_console_log"),
  workshopRequirements: (ids: string[]) => invoke<{ items: Record<string, Requirement[]>; rateLimited: boolean }>("workshop_requirements", { ids }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  listBackups: () => invoke<Backup[]>("list_backups"),
  restoreBackup: (name: string) => invoke<void>("restore_backup", { name }),
  workshopDetails: (ids: string[]) => invoke<Record<string, WorkshopInfo>>("workshop_details", { ids }),
  storeGet: <T>(name: string) => invoke<T | null>("store_get", { name }),
  storeSet: (name: string, value: unknown) => invoke<void>("store_set", { name, value }),
  machineName: () => invoke<string>("machine_name"),
  exportConfig: (path: string, config: unknown) => invoke<void>("export_config", { path, config }),
  importConfig: (path: string) => invoke<unknown>("import_config", { path }),
};

export const severityRank: Record<Severity, number> = { harmless: 0, low: 1, medium: 2, high: 3 };

export const STALE_PREFIX = "STALE:";

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
