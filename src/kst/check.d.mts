export type KstSeverity = "error" | "warn";

export interface KstRule {
  readonly id: string;
  readonly lang: "ts" | "sql" | "meta";
  readonly severity: KstSeverity;
  readonly message: string;
}

export interface KstFinding {
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: string;
  message: string;
  text: string;
}

export interface KstAllowEntry {
  file: string;
  rule: string;
  match: string;
  reason: string;
  expires?: string;
  expired: boolean;
  used: boolean;
  index: number;
}

export const RULES: ReadonlyArray<KstRule>;
export function seoulToday(now?: Date): string;
export function parseConfig(
  config: unknown,
  today?: string,
): { entries: KstAllowEntry[]; exclude: string[]; problems: Array<{ index: number; why: string }> };
export function checkSource(p: { file: string; text: string; entries?: KstAllowEntry[] }): { findings: KstFinding[]; suppressed: number };
export function run(argv: string[], io?: { out?: (s: string) => void; err?: (s: string) => void; today?: string }): number;
