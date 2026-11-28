/**
 * 누락률·오탐률 계산. 가드 구현은 어댑터로 받는다(쉐어드 ai-guard 외 다른 구현도 같은 예문으로 잴 수 있게).
 * 판정 기준:
 *  - 개인정보 칸: 의미 있는 글자(문자·숫자)가 전부 토큰으로 덮이면 «가림», 일부만 덮이면 «부분»(=일부 노출), 하나도 안 덮이면 «누락».
 *    호출 자체가 막히면(ok:false) «차단» — 밖으로 나가지 않으므로 누락이 아니다.
 *  - 미끼 칸(개인정보 아님): 글자가 하나라도 토큰으로 덮이면 «오탐», 예문이 통째로 막히면 «과잉 차단».
 *  - 토큰 원문 위치는 출력의 고정 글자 조각을 정규화 입력에 맞춰 되짚어 찾는다(토큰이 붙어 있으면 그 구간을 함께 묶는다).
 */
import type { DecoyCat, PiiKind, Sample } from "./dataset";

export type GuardOutcome = { ok: true; output: string } | { ok: false; reason: string };
export interface Adapter {
  name: string;
  normalize: (raw: string) => string;
  run: (raw: string) => GuardOutcome;
}

const TOKEN_RE = /\[([A-Z]+)_(\d+)\]/g;
const SIG = /[\p{L}\p{N}]/u;

interface TokSpan {
  prefix: string;
  start: number;
  end: number;
}

/** 출력(토큰 치환본) → 정규화 입력 위의 토큰 구간. 맞출 수 없으면 null. */
export function alignTokens(norm: string, output: string): TokSpan[] | null {
  const lits: string[] = [];
  const toks: string[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(output)) !== null) {
    lits.push(output.slice(last, m.index));
    toks.push(m[1]!);
    last = m.index + m[0].length;
  }
  lits.push(output.slice(last));
  if (toks.length === 0) return norm === output ? [] : null;
  if (!norm.startsWith(lits[0]!) || !norm.endsWith(lits[lits.length - 1]!)) return null;
  const spans: TokSpan[] = [];
  let pos = lits[0]!.length;
  let j = 0;
  while (j < toks.length) {
    // 붙어 있는 토큰 묶음(사이 글자 없음)
    let k = j;
    while (k + 1 < toks.length && lits[k + 1] === "") k++;
    let end: number;
    if (k === toks.length - 1) end = norm.length - lits[lits.length - 1]!.length;
    else end = norm.indexOf(lits[k + 1]!, pos + 1);
    if (end < pos) return null;
    for (let t = j; t <= k; t++) spans.push({ prefix: toks[t]!, start: pos, end });
    pos = end + (k === toks.length - 1 ? 0 : lits[k + 1]!.length);
    j = k + 1;
  }
  return spans;
}

const PREFIX_TO_KIND: Record<string, string> = { RRN: "RESIDENT_ID", BIZ: "BIZNO", PHONE: "PHONE", ACCT: "ACCOUNT", EMAIL: "EMAIL", CARD: "CARD", ORG: "ORG", PERSON: "PERSON", ADDR: "ADDRESS", PLATE: "PLATE", SECRET: "SECRET_LIKE", KNOWN: "KNOWN" };
export const EXPECTED: Record<PiiKind, string> = { NAME: "PERSON", PHONE: "PHONE", RRN: "RESIDENT_ID", BIZNO: "BIZNO", ACCOUNT: "ACCOUNT", CARD: "CARD", ADDRESS: "ADDRESS", EMAIL: "EMAIL", PLATE: "PLATE" };

export type PiiStatus = "가림" | "부분" | "누락" | "차단";
export interface PiiResult {
  sample: string;
  kind: PiiKind;
  variant: string;
  status: PiiStatus;
  /** 덮은 토큰 종류(가림·부분일 때) */
  maskedAs: string[];
  text: string;
  value: string;
}
export interface DecoyResult {
  sample: string;
  cat: DecoyCat;
  variant: string;
  fp: boolean;
  blocked: boolean;
  maskedAs: string[];
  value: string;
}
export interface Evaluation {
  adapter: string;
  samples: number;
  blockedSamples: number;
  blockReasons: Record<string, number>;
  unaligned: string[];
  pii: PiiResult[];
  decoys: DecoyResult[];
  /** 개인정보 칸과 겹치지 않는 토큰(종류별) — 일반 문장·미끼를 가린 것 */
  strayTokens: Record<string, number>;
  totalTokens: Record<string, number>;
}

export function evaluate(adapter: Adapter, samples: Sample[]): Evaluation {
  const ev: Evaluation = { adapter: adapter.name, samples: samples.length, blockedSamples: 0, blockReasons: {}, unaligned: [], pii: [], decoys: [], strayTokens: {}, totalTokens: {} };
  for (const s of samples) {
    const raw = s.segs.map((x) => (typeof x === "string" ? x : x.v)).join("");
    const norm = adapter.normalize(raw);
    // 칸 위치(정규화 기준)
    const ranges: Array<{ seg: Exclude<Sample["segs"][number], string>; a: number; b: number }> = [];
    let cur = 0;
    let lost = false;
    for (const seg of s.segs) {
      const v = typeof seg === "string" ? seg : seg.v;
      const nv = adapter.normalize(v);
      if (nv.length === 0) continue;
      const idx = norm.indexOf(nv, cur);
      if (idx < 0) {
        lost = true;
        continue;
      }
      if (typeof seg !== "string") ranges.push({ seg, a: idx, b: idx + nv.length });
      cur = idx + nv.length;
    }
    const res = adapter.run(raw);
    let spans: TokSpan[] = [];
    if (res.ok) {
      const al = alignTokens(norm, res.output);
      if (al === null || lost) {
        ev.unaligned.push(s.id);
        continue;
      }
      spans = al;
    } else {
      ev.blockedSamples++;
      ev.blockReasons[res.reason] = (ev.blockReasons[res.reason] ?? 0) + 1;
    }
    const kindsOver = (a: number, b: number): { covered: number; total: number; kinds: string[] } => {
      let covered = 0;
      let total = 0;
      const kinds = new Set<string>();
      for (let i = a; i < b; i++) {
        if (!SIG.test(norm[i]!)) continue;
        total++;
        const hit = spans.filter((t) => t.start <= i && i < t.end);
        if (hit.length > 0) {
          covered++;
          for (const h of hit) kinds.add(PREFIX_TO_KIND[h.prefix] ?? h.prefix);
        }
      }
      return { covered, total, kinds: [...kinds] };
    };
    for (const r of ranges) {
      const seg = r.seg;
      if ("pii" in seg) {
        let status: PiiStatus;
        let kinds: string[] = [];
        if (!res.ok) status = "차단";
        else {
          const k = kindsOver(r.a, r.b);
          kinds = k.kinds;
          status = k.covered === 0 ? "누락" : k.covered === k.total ? "가림" : "부분";
        }
        ev.pii.push({ sample: s.id, kind: seg.pii, variant: seg.variant, status, maskedAs: kinds, text: raw, value: seg.v });
      } else {
        const k = res.ok ? kindsOver(r.a, r.b) : { covered: 0, total: 0, kinds: [] };
        ev.decoys.push({ sample: s.id, cat: seg.decoy, variant: seg.variant, fp: !res.ok || k.covered > 0, blocked: !res.ok, maskedAs: k.kinds, value: seg.v });
      }
    }
    if (res.ok) {
      const piiRanges = ranges.filter((r) => "pii" in r.seg);
      for (const t of spans) {
        const kind = PREFIX_TO_KIND[t.prefix] ?? t.prefix;
        ev.totalTokens[kind] = (ev.totalTokens[kind] ?? 0) + 1;
        if (!piiRanges.some((r) => t.start < r.b && r.a < t.end)) ev.strayTokens[kind] = (ev.strayTokens[kind] ?? 0) + 1;
      }
    }
  }
  return ev;
}

// ── 표 만들기 ─────────────────────────────────────────────
const pct = (n: number, d: number): string => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);

export function renderMarkdown(ev: Evaluation, title: string): string {
  const L: string[] = [];
  L.push(`### ${title}`, "");
  L.push(`- 예문 ${ev.samples}건 · 통째 차단 ${ev.blockedSamples}건${Object.keys(ev.blockReasons).length ? ` (${Object.entries(ev.blockReasons).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""} · 위치 맞춤 실패(집계 제외) ${ev.unaligned.length}건${ev.unaligned.length ? ` (${ev.unaligned.join(", ")})` : ""}`, "");

  L.push("**종류별 누락률** (누락률 = (누락+부분)/표본, 차단은 «안 샘»으로 침)", "");
  L.push("| 종류 | 표본 | 가림 | 다른 종류로 가림 | 부분 노출 | 누락 | 차단 | **누락률** |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  const kinds: PiiKind[] = ["NAME", "PHONE", "RRN", "BIZNO", "ACCOUNT", "CARD", "ADDRESS", "EMAIL", "PLATE"];
  let tot = 0;
  let totLeak = 0;
  for (const k of kinds) {
    const rs = ev.pii.filter((r) => r.kind === k);
    const c = (st: PiiStatus): number => rs.filter((r) => r.status === st).length;
    const other = rs.filter((r) => r.status === "가림" && !r.maskedAs.includes(EXPECTED[k])).length;
    const leak = c("누락") + c("부분");
    tot += rs.length;
    totLeak += leak;
    L.push(`| ${k} | ${rs.length} | ${c("가림")} | ${other} | ${c("부분")} | ${c("누락")} | ${c("차단")} | **${pct(leak, rs.length)}** |`);
  }
  L.push(`| 합계 | ${tot} | | | | | | **${pct(totLeak, tot)}** |`, "");

  L.push("**미끼(개인정보 아님) 분류별 오탐률**", "");
  L.push("| 분류 | 표본 | 오탐 | 과잉 차단 | **오탐률** | 잘못 붙은 종류 |", "|---|---:|---:|---:|---:|---|");
  const cats = [...new Set(ev.decoys.map((d) => d.cat))];
  let dt = 0;
  let df = 0;
  for (const c of cats) {
    const ds = ev.decoys.filter((d) => d.cat === c);
    const fp = ds.filter((d) => d.fp).length;
    const bl = ds.filter((d) => d.blocked).length;
    const as = new Map<string, number>();
    for (const d of ds) for (const k of d.maskedAs) as.set(k, (as.get(k) ?? 0) + 1);
    dt += ds.length;
    df += fp;
    L.push(`| ${c} | ${ds.length} | ${fp - bl} | ${bl} | **${pct(fp, ds.length)}** | ${[...as].map(([k, n]) => `${k}×${n}`).join(", ") || "-"} |`);
  }
  L.push(`| 합계 | ${dt} | | | **${pct(df, dt)}** | |`, "");

  L.push("**토큰 종류별 과잉 가림** (그 종류 토큰 중 실제 개인정보와 겹치지 않은 비율)", "");
  L.push("| 토큰 종류 | 전체 토큰 | 개인정보 아님 | **오탐 비율** |", "|---|---:|---:|---:|");
  for (const [k, n] of Object.entries(ev.totalTokens).sort((a, b) => b[1] - a[1])) {
    const s = ev.strayTokens[k] ?? 0;
    L.push(`| ${k} | ${n} | ${s} | **${pct(s, n)}** |`);
  }
  L.push("");

  L.push("**누락·부분 노출 변형 상위**", "");
  L.push("| 종류 | 변형 | 누락+부분 / 표본 |", "|---|---|---:|");
  const byVar = new Map<string, { n: number; leak: number }>();
  for (const r of ev.pii) {
    const key = `${r.kind}\u0000${r.variant}`;
    const e = byVar.get(key) ?? { n: 0, leak: 0 };
    e.n++;
    if (r.status === "누락" || r.status === "부분") e.leak++;
    byVar.set(key, e);
  }
  for (const [key, e] of [...byVar].filter(([, e]) => e.leak > 0).sort((a, b) => b[1].leak - a[1].leak || b[1].leak / b[1].n - a[1].leak / a[1].n)) {
    const [k, v] = key.split("\u0000");
    L.push(`| ${k} | ${v} | ${e.leak} / ${e.n} |`);
  }
  L.push("");

  L.push("**오탐 변형 상위**", "");
  L.push("| 분류 | 변형 | 오탐 / 표본 | 잘못 붙은 종류 |", "|---|---|---:|---|");
  const byD = new Map<string, { n: number; fp: number; as: Set<string> }>();
  for (const d of ev.decoys) {
    const key = `${d.cat}\u0000${d.variant}`;
    const e = byD.get(key) ?? { n: 0, fp: 0, as: new Set<string>() };
    e.n++;
    if (d.fp) e.fp++;
    for (const k of d.maskedAs) e.as.add(k);
    byD.set(key, e);
  }
  for (const [key, e] of [...byD].filter(([, e]) => e.fp > 0).sort((a, b) => b[1].fp - a[1].fp)) {
    const [c, v] = key.split("\u0000");
    L.push(`| ${c} | ${v} | ${e.fp} / ${e.n} | ${[...e.as].join(", ") || "(차단)"} |`);
  }
  L.push("");
  return L.join("\n");
}
