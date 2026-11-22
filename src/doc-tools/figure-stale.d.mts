export interface FigureEntry {
  id: string;
  file: string;
  sources: string[] | null;
  screen?: string | null;
  badScreen?: boolean;
  capturedCommit: string;
}
export interface FigureManifest {
  imageBase?: string | null;
  figures: FigureEntry[];
  globalWatch: string[];
}
export interface FigureResult {
  stale: { id: string; file: string; changed: string[]; commit: string }[];
  unknown: { id: string; file: string; why: string }[];
  missing: { id: string; file: string }[];
  unregistered: { doc: string; line: number; path: string }[];
  globalChanged: { files: string[]; figures: number } | null;
  ok: number;
  total: number;
}
export function buildInit(args: { repo: string; docs: string[]; imageBase?: string | null; existingRaw?: unknown }): { manifest: unknown; added: number; kept: number };
export function parseManifest(raw: unknown): FigureManifest;
export function collectRefs(repo: string, docGlobs: string[], imageBase?: string | null): { doc: string; line: number; path: string }[];
export function checkFigures(args: { manifest: FigureManifest; repo: string; docs?: string[]; unregistered?: boolean; globalWatch?: string[]; imageBase?: string | null }): FigureResult;
export function formatReport(res: FigureResult): string[];
export function parseArgs(argv: string[]): any;
export function run(argv: string[], io?: { out?: (s: string) => void; err?: (s: string) => void }): number;
