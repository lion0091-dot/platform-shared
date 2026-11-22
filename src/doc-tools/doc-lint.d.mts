export interface DocLintViolation {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}
export interface DocLintConfig {
  include: string[];
  exclude: string[];
  rules: Record<string, any>;
}
export function globToRegExp(glob: string): RegExp;
export function listFiles(rootDir: string): string[];
export function matchFiles(all: string[], include: string[], exclude?: string[]): string[];
export function maskMarkdown(text: string, opts?: { keepLinks?: boolean }): string;
export function maskQuoted(line: string, pairs: string[]): string;
export function parseConfig(raw: unknown): DocLintConfig;
export function lintLines(file: string, text: string, cfg: DocLintConfig, active: Set<string>): DocLintViolation[];
export function extractBlock(text: string, g: any): { lines: string[]; line: number } | null;
export function normalizeBlock(lines: string[], g: any): string[];
export function checkSameBlock(g: any, files: string[], readText: (f: string) => string, readAbs?: (p: string) => string | null, notices?: string[]): DocLintViolation[];
export function runDocLint(cfg: DocLintConfig, rootDir: string): { violations: DocLintViolation[]; notices: string[]; files: number };
export function parseArgs(argv: string[]): { config: string; root: string };
export function run(argv: string[], io?: { out?: (s: string) => void; err?: (s: string) => void }): number;
