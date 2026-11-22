#!/usr/bin/env node
/**
 * 문서 검사기(doc-lint). Node 내장 모듈만 쓴다(의존성 0). 읽기 전용이다(--fix 없음: 치환은 사람이 정한다).
 *
 *   node doc-lint.mjs --config FILE [--root DIR]
 *
 * - 규칙·예외·허용 목록은 전부 설정 JSON 에 있다. 코드에는 특정 서비스·고객·문구가 없다. 설정 예: `doc-lint.example.json`.
 * - 규칙(설정에 객체가 있어야 켜진다. `"enabled": false` 로 끌 수 있다):
 *     nounJul    «줄» 명사(행) 검출. 동사 활용·허용 어간은 allow 로 제외한다.
 *     english    코드·링크 밖 영어 단어 검출(허용 단어·패턴·화면 표기 예외표, « » 안 인용 제외 옵션).
 *     forbidden  금지어 정규식(설정).
 *     sameBlock  여러 문서의 같은 구간(시작·끝 표지)이 정규화 뒤 같은지 해시로 비교.
 *                정본 파일(저장소 밖 절대 경로, canonical)과 비교하거나(없으면 건너뛰고 문서끼리 비교로 대신) 문서끼리 비교한다(mode: auto|canonical|mutual).
 *     emphasis   이모지·강조 남발 의심(선택).
 * - 검사에서 빼는 곳(모든 행 단위 규칙): 코드 블록, 인라인 코드, 링크 주소·URL·참조 정의, HTML 주석·태그.
 * - 출력: `파일:행:규칙:발췌` + 합계. 종료 코드 0 = 위반 없음, 1 = 위반 있음, 2 = 사용법·설정 오류.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const BOM = String.fromCharCode(0xfeff);
const stripBom = (s) => (s.startsWith(BOM) ? s.slice(1) : s);

// ── 파일 찾기(의존성 없는 glob) ─────────────────────────────────
/** glob → 정규식. `**` 는 경로 구분자를 넘고 `*`·`?` 는 넘지 않는다. */
export function globToRegExp(glob) {
  const g = String(glob).split(String.fromCharCode(92)).join("/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");
}

/** rootDir 아래 모든 파일의 상대 경로('/' 구분). node_modules·.git 은 들어가지 않는다. */
export function listFiles(rootDir) {
  const out = [];
  const walk = (rel) => {
    for (const ent of readdirSync(path.join(rootDir, rel), { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(rel === "" ? ent.name : `${rel}/${ent.name}`);
      } else if (ent.isFile()) out.push(rel === "" ? ent.name : `${rel}/${ent.name}`);
    }
  };
  walk("");
  return out.sort();
}

export function matchFiles(all, include, exclude = []) {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return all.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
}

// ── 마크다운 가림(길이·줄바꿈 유지) ─────────────────────────────
/** 코드 블록·인라인 코드·링크 주소·URL·참조 정의·HTML 주석·태그를 공백으로 바꾼다. 행·열 위치는 그대로다. opts.keepLinks 면 링크·태그는 남긴다(그림 참조 수집용). */
export function maskMarkdown(text, opts = {}) {
  const out = text.split("");
  const blank = (s, e) => {
    for (let i = s; i < e && i < out.length; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
  };
  const each = (re, fn) => {
    const s = out.join("");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      fn(m);
      if (m[0] === "") re.lastIndex++;
    }
  };

  // 1) 펜스 코드 블록
  let pos = 0;
  let fence = null;
  let fenceStart = 0;
  for (const line of text.split("\n")) {
    if (fence === null) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m && !(m[1][0] === "`" && line.slice(m[0].length).includes("`"))) {
        fence = { ch: m[1][0], n: m[1].length };
        fenceStart = pos;
      }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.n) {
        blank(fenceStart, pos + line.length);
        fence = null;
      }
    }
    pos += line.length + 1;
  }
  if (fence !== null) blank(fenceStart, out.length);

  // 2) 인라인 코드(빈 줄을 넘지 않는다)
  each(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)/g, (m) => blank(m.index, m.index + m[0].length));
  // 3) HTML 주석(닫히지 않으면 끝까지)
  each(/<!--[\s\S]*?(?:-->|$)/g, (m) => blank(m.index, m.index + m[0].length));
  if (opts.keepLinks === true) return out.join("");
  // 4) 링크 주소 `](주소 "제목")`, 참조 정의의 주소, 맨 URL, HTML 태그
  each(/\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/dg, (m) => blank(m.indices[1][0], m.indices[1][1]));
  each(/^( {0,3}\[[^\]\n]+\]:[ \t]*)(\S+)/dgm, (m) => blank(m.indices[2][0], m.indices[2][1]));
  each(/\bhttps?:\/\/[^\s)>\]]+/g, (m) => blank(m.index, m.index + m[0].length));
  each(/<\/?[A-Za-z][^<>\n]*>/g, (m) => blank(m.index, m.index + m[0].length));
  return out.join("");
}

/** « » 같은 따옴표 쌍 안쪽을 공백으로 바꾼다(같은 행 안에서만). */
export function maskQuoted(line, pairs) {
  let s = line;
  for (const pair of pairs) {
    const [open, close] = [...pair];
    if (open === undefined || close === undefined) continue;
    const re = new RegExp(`${escapeRe(open)}[^${escapeRe(close)}\\n]*${escapeRe(close)}`, "g");
    s = s.replace(re, (m) => m.replace(/[^\r\n]/g, " "));
  }
  return s;
}

function excerptOf(rawLine, col, len, max = 100) {
  const t = rawLine.replace(/\r$/, "");
  if (t.length <= max) return t.trim();
  const start = Math.max(0, Math.min(col - Math.floor((max - len) / 2), t.length - max));
  return `${start > 0 ? "…" : ""}${t.slice(start, start + max).trim()}${start + max < t.length ? "…" : ""}`;
}

// ── 설정 ───────────────────────────────────────────────────────
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const strArr = (v, name) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`설정 오류: ${name} 은 문자열 배열이어야 한다.`);
  return v;
};
const compile = (src, flags, name) => {
  try {
    return new RegExp(src, flags ?? "u");
  } catch (e) {
    throw new Error(`설정 오류: ${name} 정규식을 읽을 수 없다(${e instanceof Error ? e.message : String(e)}).`);
  }
};

/** 화면 표기 라벨 → 정규식. 영문·숫자로 시작/끝나는 라벨은 단어 경계를 지킨다(구절 단위, 대소문자 구분). */
function labelRegExp(text) {
  const pre = /^[A-Za-z0-9_]/.test(text) ? "(?<![A-Za-z0-9_])" : "";
  const post = /[A-Za-z0-9_]$/.test(text) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${pre}${escapeRe(text)}${post}`, "g");
}

/** 화면 표기 예외표 [{file | files[], text}] 검증·정규화. file·files 를 모두 생략하면 모든 파일에 적용. */
function parseScreenLabels(list, name) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`설정 오류: ${name} 은 배열이어야 한다.`);
  return list.map((x, i) => {
    const filesOk = x.files === undefined || (Array.isArray(x.files) && x.files.every((f) => typeof f === "string"));
    if (!isObj(x) || typeof x.text !== "string" || x.text === "" || (x.file !== undefined && typeof x.file !== "string") || !filesOk) {
      throw new Error(`설정 오류: ${name}[${i}] 는 {file 또는 files[], text} 여야 한다.`);
    }
    const globs = [...(x.file !== undefined ? [x.file] : []), ...(x.files ?? [])];
    return { files: globs.length === 0 ? null : globs.map(globToRegExp), re: labelRegExp(x.text) };
  });
}

/** 예외표 적용: 해당 파일에서 라벨 문구를 같은 길이의 공백으로 바꾼다(위치 유지). */
function applyLabels(line, file, labels) {
  let s = line;
  for (const lb of labels) {
    if (lb.files !== null && !lb.files.some((r) => r.test(file))) continue;
    s = s.replace(lb.re, (m) => " ".repeat(m.length));
  }
  return s;
}

/** nounJul 허용 항목 분류: 공백 없는 문자열 = 어간(단어에 포함되면 제외), 공백 포함 문자열(공백은 \s+ 로 본다)·{regex, flags} = 구절 정규식(그 구간 안의 «줄»은 제외). */
function parseJulAllow(list) {
  if (list === undefined) return { stems: [], phrases: [] };
  if (!Array.isArray(list)) throw new Error("설정 오류: nounJul.allow 는 배열이어야 한다.");
  const stems = [];
  const phrases = [];
  list.forEach((a, i) => {
    if (typeof a === "string" && a !== "") {
      if (/\s/.test(a)) phrases.push(new RegExp(a.trim().split(/\s+/).map(escapeRe).join("\\s+"), "g"));
      else stems.push(a);
    } else if (isObj(a) && typeof a.regex === "string") {
      const base = a.flags ?? "u";
      phrases.push(compile(a.regex, base.includes("g") ? base : `${base}g`, `nounJul.allow[${i}]`));
    } else throw new Error(`설정 오류: nounJul.allow[${i}] 는 문자열 또는 {regex, flags} 여야 한다.`);
  });
  return { stems, phrases };
}

/** 설정 JSON 을 검증·정규화한다. 잘못되면 Error. */
export function parseConfig(raw) {
  if (!isObj(raw)) throw new Error("설정 오류: 최상위는 객체여야 한다.");
  const include = strArr(raw.include, "include");
  if (include.length === 0) throw new Error("설정 오류: include(대상 glob)가 비어 있다.");
  const exclude = strArr(raw.exclude, "exclude");
  const rules = isObj(raw.rules) ? raw.rules : {};
  const on = (r) => isObj(r) && r.enabled !== false;
  const scope = (r) => ({ files: r.files === undefined ? null : strArr(r.files, "rules.files"), exclude: strArr(r.exclude, "rules.exclude") });
  const cfg = { include, exclude, rules: {} };

  if (on(rules.nounJul)) {
    cfg.rules.nounJul = { ...scope(rules.nounJul), ...parseJulAllow(rules.nounJul.allow), screenLabels: parseScreenLabels(rules.nounJul.screenLabels, "nounJul.screenLabels") };
  }
  if (on(rules.english)) {
    const r = rules.english;
    const q = r.skipQuoted;
    const pairs = q === true ? ["«»"] : Array.isArray(q) ? strArr(q, "english.skipQuoted") : [];
    cfg.rules.english = {
      ...scope(r),
      allowWords: new Set(strArr(r.allowWords, "english.allowWords").map((w) => w.toLowerCase())),
      allowPatterns: strArr(r.allowPatterns, "english.allowPatterns").map((p) => compile(p, "u", "english.allowPatterns")),
      minLength: Number.isInteger(r.minLength) && r.minLength >= 1 ? r.minLength : 2,
      quotePairs: pairs,
      screenLabels: parseScreenLabels(r.screenLabels, "english.screenLabels"),
      skipForbiddenMatches: r.skipForbiddenMatches === true,
    };
  }
  if (on(rules.forbidden)) {
    const list = rules.forbidden.patterns;
    if (!Array.isArray(list) || list.length === 0) throw new Error("설정 오류: forbidden.patterns 가 비어 있다.");
    cfg.rules.forbidden = {
      ...scope(rules.forbidden),
      patterns: list.map((p, i) => {
        if (!isObj(p) || typeof p.regex !== "string") throw new Error(`설정 오류: forbidden.patterns[${i}].regex 가 없다.`);
        const base = p.flags ?? "u";
        return { id: typeof p.id === "string" && p.id !== "" ? p.id : String(i + 1), re: compile(p.regex, base.includes("g") ? base : `${base}g`, `forbidden.patterns[${i}]`), raw: p.raw === true };
      }),
    };
  }
  if (on(rules.sameBlock)) {
    const groups = rules.sameBlock.groups;
    if (!Array.isArray(groups) || groups.length === 0) throw new Error("설정 오류: sameBlock.groups 가 비어 있다.");
    const marker = (m, name) => {
      if (typeof m === "string" && m !== "") return { kind: "text", text: m };
      if (isObj(m) && typeof m.regex === "string") return { kind: "regex", re: compile(m.regex, m.flags ?? "u", name) };
      throw new Error(`설정 오류: ${name} 은 문자열 또는 {regex, flags} 여야 한다.`);
    };
    cfg.rules.sameBlock = {
      groups: groups.map((g, i) => {
        if (!isObj(g)) throw new Error(`설정 오류: sameBlock.groups[${i}] 가 객체가 아니다.`);
        const files = strArr(g.files, `sameBlock.groups[${i}].files`);
        if (files.length === 0) throw new Error(`설정 오류: sameBlock.groups[${i}].files 가 비어 있다.`);
        const n = isObj(g.normalize) ? g.normalize : {};
        return {
          id: typeof g.id === "string" && g.id !== "" ? g.id : String(i + 1),
          start: marker(g.start, `sameBlock.groups[${i}].start`),
          end: marker(g.end, `sameBlock.groups[${i}].end`),
          includeStart: g.includeStart === true,
          includeEnd: g.includeEnd === true,
          files,
          exclude: strArr(g.exclude, `sameBlock.groups[${i}].exclude`),
          canonical: typeof g.canonical === "string" && g.canonical !== "" ? g.canonical : null,
          mode: g.mode === "mutual" || g.mode === "canonical" ? g.mode : "auto",
          ignoreNumbering: n.ignoreNumbering !== false,
          collapseWhitespace: n.collapseWhitespace !== false,
          stripEmphasis: n.stripEmphasis === true,
        };
      }),
    };
  }
  if (on(rules.emphasis)) {
    const r = rules.emphasis;
    cfg.rules.emphasis = { ...scope(r), emoji: r.emoji !== false, maxBoldPerLine: Number.isInteger(r.maxBoldPerLine) && r.maxBoldPerLine >= 0 ? r.maxBoldPerLine : 3 };
  }
  return cfg;
}

// ── 행 단위 규칙 ────────────────────────────────────────────────
const HANGUL_JUL = /[가-힣]*줄[가-힣]*/g;
const WORD = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*/g;
const EMOJI = /\p{Extended_Pictographic}/u;

/** 단어를 둘러싼 «공백으로 끊긴 덩어리»(앞뒤 문장부호 제외). 파일 이름·경로·커밋 해시·버전 같은 패턴 허용에 쓴다. */
function chunkAround(line, index, len) {
  let a = index;
  let b = index + len;
  while (a > 0 && !/\s/.test(line[a - 1])) a--;
  while (b < line.length && !/\s/.test(line[b])) b++;
  return line
    .slice(a, b)
    .replace(/^[([{"'“”‘’«»<>,.;:!?]+/, "")
    .replace(/[)\]}"'“”‘’«»<>,.;:!?]+$/, "");
}

/** 한 파일의 행 단위 규칙을 돌려 위반 목록을 만든다. active = 이 파일에 켜진 규칙 키 집합. */
export function lintLines(file, text, cfg, active) {
  const v = [];
  const rawLines = text.split("\n");
  const masked = maskMarkdown(text).split("\n");
  const add = (i, rule, col, len) => v.push({ file, line: i + 1, rule, excerpt: excerptOf(rawLines[i], col, len) });

  for (let i = 0; i < masked.length; i++) {
    const line = masked[i];
    if (active.has("nounJul")) {
      const { stems, phrases, screenLabels } = cfg.rules.nounJul;
      const jline = applyLabels(line, file, screenLabels);
      const spans = phrases.flatMap((re) => [...jline.matchAll(re)].map((p) => [p.index, p.index + p[0].length]));
      for (const m of jline.matchAll(HANGUL_JUL)) {
        const word = m[0];
        if (stems.some((a) => word.includes(a))) continue;
        const at = m.index + word.indexOf("줄");
        if (spans.some(([s, e]) => at >= s && at < e)) continue; // 띄어 쓴 허용 구절 안의 «줄»
        const before = jline.slice(0, m.index);
        if (/[:：]$/.test(before) || /[:：]\d+(?:[-–~]\d+)?$/.test(before)) continue; // 파일:줄 인용 형식
        add(i, "noun-jul", m.index, word.length);
      }
    }
    if (active.has("english")) {
      const r = cfg.rules.english;
      let scan = r.quotePairs.length > 0 ? maskQuoted(line, r.quotePairs) : line;
      scan = applyLabels(scan, file, r.screenLabels);
      if (r.skipForbiddenMatches && cfg.rules.forbidden !== undefined) {
        // 금지어 규칙이 이미 보고하는 구간은 영어 규칙에서 다시 세지 않는다(합계 부풀림 방지).
        for (const p of cfg.rules.forbidden.patterns) {
          for (const fm of line.matchAll(p.re)) {
            if (fm[0] !== "") scan = scan.slice(0, fm.index) + " ".repeat(fm[0].length) + scan.slice(fm.index + fm[0].length);
          }
        }
      }
      for (const m of scan.matchAll(WORD)) {
        const w = m[0];
        if (w.replace(/[^A-Za-z]/g, "").length < r.minLength) continue;
        if (r.allowWords.has(w.toLowerCase())) continue;
        const chunk = chunkAround(scan, m.index, w.length);
        if (r.allowPatterns.some((p) => p.test(w) || p.test(chunk))) continue;
        add(i, "english", m.index, w.length);
      }
    }
    if (active.has("forbidden")) {
      for (const p of cfg.rules.forbidden.patterns) {
        const src = p.raw ? rawLines[i] : line;
        p.re.lastIndex = 0;
        for (let m = p.re.exec(src); m !== null; m = p.re.exec(src)) {
          add(i, `forbidden.${p.id}`, m.index, Math.max(m[0].length, 1));
          if (m[0] === "") p.re.lastIndex++;
        }
      }
    }
    if (active.has("emphasis")) {
      const r = cfg.rules.emphasis;
      const em = r.emoji ? EMOJI.exec(line) : null;
      if (em) add(i, "emphasis.emoji", em.index, 2);
      const bold = (line.match(/\*\*[^*\n]+\*\*/g) ?? []).length;
      if (bold > r.maxBoldPerLine) add(i, "emphasis.bold", 0, line.length);
    }
  }
  return v;
}

// ── 같은 블록 검사 ──────────────────────────────────────────────
const NUMBERING = /^\s*(?:\(\d+\)|\d+[.)]|[①-⑳]|[가-힣][.)])\s*/u;

const markerHit = (m, line) => (m.kind === "text" ? line.includes(m.text) : m.re.test(line));

/** 시작·끝 표지(행 단위)로 구간을 뽑는다. 못 찾으면 null. line = 시작 표지 행 번호(1부터). */
export function extractBlock(text, g) {
  const lines = text.split("\n");
  const s = lines.findIndex((l) => markerHit(g.start, l));
  if (s < 0) return null;
  const e = lines.findIndex((l, i) => i > s && markerHit(g.end, l));
  if (e < 0) return null;
  const from = g.includeStart ? s : s + 1;
  const to = g.includeEnd ? e + 1 : e;
  return { lines: lines.slice(from, to).map((l) => l.replace(/\r$/, "")), line: s + 1 };
}

/** 번호 서식·공백·개행 차이(옵션 stripEmphasis: 굵게 ** 와 __ · 인용 > 기호)를 지운 비교용 단위 목록. */
export function normalizeBlock(lines, g) {
  const out = [];
  for (const raw of lines) {
    let l = raw.normalize("NFC");
    if (g.stripEmphasis) l = l.replace(/^\s*(?:>\s*)+/, "").replace(/\*\*|__/g, "");
    if (g.ignoreNumbering) l = l.replace(NUMBERING, "");
    l = g.collapseWhitespace ? l.replace(/\s+/g, " ").trim() : l.trimEnd();
    if (l !== "") out.push(l);
  }
  return g.collapseWhitespace ? [out.join(" ")] : out;
}

const hashOf = (norm) => createHash("sha256").update(norm.join("\n")).digest("hex").slice(0, 8);

/** 정본 파일(저장소 밖 절대 경로) 읽기. 없으면 null. 표지가 없으면 파일 전체가 정본이다. */
function loadCanonical(g, readAbs) {
  if (g.canonical === null) return null;
  const text = readAbs(g.canonical);
  if (text === null) return null;
  const block = extractBlock(text, g);
  const lines = block === null ? text.split("\n").map((l) => l.replace(/\r$/, "")) : block.lines;
  const norm = normalizeBlock(lines, g);
  return { norm, hash: hashOf(norm) };
}

const firstDiff = (a, b) => {
  const n = Math.max(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  return { k, text: (a[k] ?? "(내용 없음)").slice(0, 60) };
};

export function checkSameBlock(g, files, readText, readAbs = () => null, notices = []) {
  const v = [];
  const rule = `sameBlock.${g.id}`;
  const canon = g.mode === "mutual" ? null : loadCanonical(g, readAbs);
  if (g.canonical !== null && g.mode !== "mutual" && canon === null) {
    notices.push(`${rule}: 정본 파일이 없어 정본 비교를 건너뛴다${g.mode === "canonical" ? "" : "(문서끼리 비교로 대신한다)"}`);
  }
  if (g.mode === "canonical" && canon === null) return v;
  if (canon === null && files.length < 2) {
    // 비교할 상대가 없으면 위반이 아니라 «건너뜀» 안내다(종료 코드·합계에 넣지 않는다).
    notices.push(`${rule}: 건너뜀(정본·상대 문서 없음 — 비교 대상 문서 ${files.length}개)`);
    return v;
  }

  const found = [];
  for (const f of files) {
    const block = extractBlock(readText(f), g);
    if (block === null) {
      v.push({ file: f, line: 1, rule, excerpt: "시작·끝 표지를 찾지 못했다" });
      continue;
    }
    const norm = normalizeBlock(block.lines, g);
    found.push({ file: f, line: block.line, norm, hash: hashOf(norm) });
  }
  if (canon !== null) {
    for (const f of found) {
      if (f.hash === canon.hash) continue;
      const d = firstDiff(f.norm, canon.norm);
      v.push({ file: f.file, line: f.line, rule, excerpt: `정본과 다름(해시 ${f.hash}≠${canon.hash}, 첫 차이 ${d.k + 1}번째 단위: ${d.text})` });
    }
    return v;
  }
  if (found.length === 0) return v;
  const count = new Map();
  for (const f of found) count.set(f.hash, (count.get(f.hash) ?? 0) + 1);
  const ref = found.reduce((a, b) => ((count.get(b.hash) ?? 0) > (count.get(a.hash) ?? 0) ? b : a));
  for (const f of found) {
    if (f.hash === ref.hash) continue;
    const d = firstDiff(f.norm, ref.norm);
    v.push({ file: f.file, line: f.line, rule, excerpt: `기준 ${ref.file} 와 다름(해시 ${f.hash}≠${ref.hash}, 첫 차이 ${d.k + 1}번째 단위: ${d.text})` });
  }
  return v;
}

// ── 실행 ───────────────────────────────────────────────────────
/** 설정(parseConfig 결과)과 루트로 검사해 { violations, notices, files } 를 돌려준다. */
export function runDocLint(cfg, rootDir) {
  const all = listFiles(rootDir);
  const cache = new Map();
  const readText = (f) => {
    if (!cache.has(f)) cache.set(f, stripBom(readFileSync(path.join(rootDir, f), "utf8")));
    return cache.get(f);
  };
  const readAbs = (p) => {
    try {
      return stripBom(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const violations = [];
  const notices = [];
  const base = matchFiles(all, cfg.include, cfg.exclude);
  const perRule = {};
  for (const key of ["nounJul", "english", "forbidden", "emphasis"]) {
    const r = cfg.rules[key];
    if (r === undefined) continue;
    perRule[key] = new Set(r.files === null ? matchFiles(base, ["**"], r.exclude) : matchFiles(all, r.files, [...cfg.exclude, ...r.exclude]));
  }
  const lineFiles = new Set(Object.values(perRule).flatMap((s) => [...s]));
  for (const f of [...lineFiles].sort()) {
    const active = new Set(Object.keys(perRule).filter((k) => perRule[k].has(f)));
    violations.push(...lintLines(f, readText(f), cfg, active));
  }
  if (cfg.rules.sameBlock !== undefined) {
    for (const g of cfg.rules.sameBlock.groups) {
      violations.push(...checkSameBlock(g, matchFiles(all, g.files, [...cfg.exclude, ...g.exclude]), readText, readAbs, notices));
    }
  }
  violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { violations, notices, files: lineFiles.size };
}

const USAGE = "사용법: doc-lint --config 설정.json [--root 디렉터리]";

export function parseArgs(argv) {
  const o = { config: null, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") o.config = argv[++i];
    else if (a === "--root") o.root = argv[++i];
    else throw new Error(`알 수 없는 인자: ${a}\n${USAGE}`);
  }
  if (!o.config || !o.root) throw new Error(USAGE);
  return o;
}

export function run(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  try {
    const o = parseArgs(argv);
    const cfg = parseConfig(JSON.parse(stripBom(readFileSync(path.resolve(o.config), "utf8"))));
    const { violations, notices, files } = runDocLint(cfg, path.resolve(o.root));
    for (const n of notices) out(`안내: ${n}`);
    for (const x of violations) out(`${x.file}:${x.line}:${x.rule}:${x.excerpt}`);
    const byRule = new Map();
    for (const x of violations) {
      const key = x.rule.split(".")[0];
      byRule.set(key, (byRule.get(key) ?? 0) + 1);
    }
    out(`doc-lint: 행 단위 검사 파일 ${files}개, 위반 합계 ${violations.length}건${violations.length > 0 ? ` (${[...byRule].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`);
    return violations.length > 0 ? 1 : 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();
if (isMain) process.exitCode = run(process.argv.slice(2));
