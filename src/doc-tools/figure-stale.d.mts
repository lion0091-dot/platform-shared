export interface FigureEntry {
  id: string;
  file: string;
  sources: string[] | null;
  capturedCommit: string;
}
export interface FigureManifest {
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
export function parseManifest(raw: unknown): FigureManifest;
export function collectRefs(repo: string, docGlobs: string[]): { doc: string; line: number; path: string }[];
export function checkFigures(args: { manifest: FigureManifest; repo: string; docs?: string[]; unregistered?: boolean; globalWatch?: string[] }): FigureResult;
export function formatReport(res: FigureResult): string[];
export function parseArgs(argv: string[]): any;
export function run(argv: string[], io?: { out?: (s: string) => void; err?: (s: string) => void }): number;
