#!/usr/bin/env node
/**
 * 서울 날짜 규칙 정적 검사. Node 내장 모듈만 쓴다(의존성 0).
 *
 *   node check.mjs [--root DIR] [--config FILE] [--all | --changed-since REF] [--warn-only] [--json] [PATH...]
 *
 * - 기본: `--changed-since origin/main` (바뀐 줄만 검사). `--all` 은 전수 점검용.
 * - 종료 코드: 0 = error 없음(또는 --warn-only), 1 = error 있음, 2 = 사용법·설정·경로·git 오류.
 * - 허용: 주석 `kst-ok: <규칙ID>[,<규칙ID>] <사유>`(같은 줄, 또는 주석만 있는 윗줄) 또는 설정 파일 allow 항목(사유 필수, expires 선택).
 * - 정규식 기반 휴리스틱이다(타입 인식 없음). 오탐은 허용 목록으로 처리한다.
 * - 보지 못하는 것: 두 문장에 걸친 값(`const iso = x.toISOString(); iso.slice(0, 10)`), TS 안에 문자열로 들어 있는 SQL, 암묵 변환(`between p_from and p_to`),
 *   JSX 본문 속 `//`(주석으로 오인되어 그 줄 뒤쪽을 놓침), SQL 달러 인용 안의 짝 없는 따옴표(`$m$don't$m$`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── 규칙 목록 ───────────────────────────────────────────────────
/** @type {ReadonlyArray<{id:string, lang:"ts"|"sql"|"meta", severity:"error"|"warn", message:string}>} */
export const RULES = [
  { id: "ts-iso-slice", lang: "ts", severity: "error", message: "toISOString()/toJSON() 문자열 자르기는 UTC 날짜·월이다. kstToday()/kstDateOf() 를 쓴다." },
  { id: "ts-local-getters", lang: "ts", severity: "error", message: "로컬 시간대 getter(getFullYear·getMonth·getDate·getDay·getHours)는 서버(UTC)에서 서울 날짜가 아니다. kst 헬퍼를 쓴다." },
  { id: "ts-locale-no-tz", lang: "ts", severity: "error", message: "toLocale*String·Intl.DateTimeFormat 호출에 서울 timeZone 이 없다. formatKstDate() 또는 timeZone:\"Asia/Seoul\" 을 쓴다." },
  { id: "ts-local-ctor", lang: "ts", severity: "warn", message: "로컬 시간대 날짜 생성(연·월·일 인자, 시각 문자열에 오프셋 없음)이나 setHours·setDate·setMonth·setFullYear 는 서버(UTC)에서 서울 날짜가 아니다. parseKstDate()/kstDayRange() 를 검토한다." },
  { id: "ts-ts-slice", lang: "ts", severity: "warn", message: "시각 값 문자열의 앞 10자는 UTC 날짜일 수 있다. kstDateOf() 를 검토한다." },
  { id: "sql-current-date", lang: "sql", severity: "error", message: "current_date·now()::date·localtimestamp 등은 세션(UTC) 날짜다. kst_today() 또는 (now() at time zone 'Asia/Seoul')::date 를 쓴다." },
  { id: "sql-date-trunc", lang: "sql", severity: "error", message: "date_trunc(day|week|month|year) 에 서울 변환이 없다. at time zone 'Asia/Seoul' 을 쓴다." },
  { id: "sql-extract", lang: "sql", severity: "error", message: "extract/date_part 에 서울 변환이 없다(시각 열이면 UTC 기준). at time zone 'Asia/Seoul' 을 쓴다." },
  { id: "sql-range-cast", lang: "sql", severity: "error", message: "날짜 인자를 ::timestamptz 로 바꾸면 세션(UTC) 자정이다. kst_day_range() 또는 (x::timestamp at time zone 'Asia/Seoul') 를 쓴다." },
  { id: "sql-ts-cast-date", lang: "sql", severity: "warn", message: "시각 열을 ::date·date()·cast(as date) 로 자르면 UTC 날짜다. (col at time zone 'Asia/Seoul')::date 를 쓴다." },
  { id: "sql-to-char-date", lang: "sql", severity: "warn", message: "to_char(시각, 날짜 서식) 에 서울 변환이 없다. at time zone 'Asia/Seoul' 을 쓴다." },
  { id: "kst-ok-no-reason", lang: "meta", severity: "error", message: "kst-ok 주석에 사유가 없다(글자·숫자 2자 이상). `kst-ok: <규칙ID> <사유>` 형식으로 쓴다." },
  { id: "kst-ok-unknown-rule", lang: "meta", severity: "warn", message: "kst-ok 주석의 규칙 ID 를 알 수 없다(오타?)." },
  { id: "kst-allow-invalid", lang: "meta", severity: "error", message: "설정 allow 항목이 잘못됐다(file·rule·match·reason 필수, expires 는 실제 날짜 YYYY-MM-DD)." },
  { id: "kst-allow-expired", lang: "meta", severity: "error", message: "설정 allow 항목이 만료됐다. 고치거나 기한을 다시 정한다." },
  { id: "kst-allow-unused", lang: "meta", severity: "warn", message: "어떤 검사 결과와도 맞지 않는 allow 항목이다(--all 에서만 보고)." },
  { id: "kst-file-skipped", lang: "meta", severity: "warn", message: "파일을 검사하지 않았다(5MB 초과이거나 UTF-8 텍스트가 아니다)." },
];
const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SQL_EXT = new Set([".sql"]);
const DEFAULT_EXCLUDE_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "out", ".turbo", ".vercel", ".claude"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ARGS_CHARS = 4000;
const LOOKBACK = 64;

// ── 텍스트 도구 ─────────────────────────────────────────────────
// git 이 줄을 세는 방식과 같게 «\n» 만 줄바꿈으로 본다(CRLF 는 LF 로, 단독 CR 은 그대로 둔다).
const normalizeNewlines = (t) => t.replace(/\r\n/g, "\n");
const normPath = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
const squash = (s) => s.replace(/\s+/g, "");

function langOf(file) {
  const ext = path.extname(file).toLowerCase();
  return TS_EXT.has(ext) ? "ts" : SQL_EXT.has(ext) ? "sql" : null;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── 어휘 분석: 주석 제거 + 괄호 짝 색인(한 번 O(n)) ──────────────────
const REGEX_PREV_WORDS = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "yield", "await"]);
const REGEX_PREV_CHARS = "(,=:[!&|?{};~^%+-*"; // < > 는 뺀다: JSX 닫는 태그(</span>)를 정규식으로 오인하지 않기 위해
const REGEX_MAX_CHARS = 300; // 정규식 리터럴로 볼 최대 길이(닫는 / 를 못 찾는 입력에서 이차 시간이 되지 않게)

/**
 * @returns {{cleaned:string, comments:Array<[number,number]>, open2close:Int32Array, close2open:Int32Array}}
 * cleaned: 주석을 공백으로 바꾼 텍스트(길이·줄바꿈 유지). 문자열 내용은 그대로 둔다.
 * 괄호 색인: 코드(템플릿의 ${} 포함) 안의 괄호만 짝을 짓고, 문자열·정규식·주석 안의 괄호는 무시한다. 너무 먼 짝은 없는 것으로 본다.
 */
function lex(text, lang) {
  const n = text.length;
  const parts = [];
  const comments = [];
  const open2close = new Int32Array(n).fill(-1);
  const close2open = new Int32Array(n).fill(-1);
  const pstack = [];
  let last = 0;
  let i = 0;
  const blank = (s, e) => {
    parts.push(text.slice(last, s), text.slice(s, e).replace(/[^\n]/g, " "));
    comments.push([s, e]);
    last = e;
  };
  const open = (at) => pstack.push(at);
  const close = (at) => {
    if (pstack.length === 0) return;
    const o = pstack.pop();
    if (at - o <= MAX_ARGS_CHARS) {
      open2close[o] = at;
      close2open[at] = o;
    }
  };

  if (lang === "ts") {
    const modes = []; // "tpl" | 숫자(템플릿 ${} 안의 중괄호 깊이)
    let prevSig = "";
    let prevWord = "";
    while (i < n) {
      const top = modes.length > 0 ? modes[modes.length - 1] : -1;
      const c = text[i];
      if (top === "tpl") {
        if (c === "\\") i += 2;
        else if (c === "`") {
          modes.pop();
          prevSig = "`";
          i++;
        } else if (c === "$" && text[i + 1] === "{") {
          modes.push(0);
          prevSig = "{";
          i += 2;
        } else i++;
        continue;
      }
      const d = text[i + 1];
      if (c === "/" && d === "/") {
        let e = text.indexOf("\n", i);
        if (e < 0) e = n;
        blank(i, e);
        i = e;
      } else if (c === "/" && d === "*") {
        let e = text.indexOf("*/", i + 2);
        e = e < 0 ? n : e + 2;
        blank(i, e);
        i = e;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (text[j] === "\\") j += 2;
          else if (text[j] === c) {
            j++;
            break;
          } else if (text[j] === "\n") break;
          else j++;
        }
        i = j;
        prevSig = c;
        prevWord = "";
      } else if (c === "`") {
        modes.push("tpl");
        prevWord = "";
        i++;
      } else if (c === "/") {
        const regexOk = prevSig === "" || REGEX_PREV_CHARS.includes(prevSig) || REGEX_PREV_WORDS.has(prevWord);
        let end = -1;
        if (regexOk) {
          let inClass = false;
          for (let j = i + 1; j < n && j - i <= REGEX_MAX_CHARS; j++) {
            const ch = text[j];
            if (ch === "\\") j++;
            else if (ch === "\n") break;
            else if (inClass) {
              if (ch === "]") inClass = false;
            } else if (ch === "[") inClass = true;
            else if (ch === "/") {
              end = j;
              break;
            }
          }
        }
        if (end >= 0) {
          i = end + 1;
          while (i < n && /[a-z]/.test(text[i])) i++;
          prevSig = ")";
        } else {
          prevSig = "/";
          i++;
        }
        prevWord = "";
      } else if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(text[j])) j++;
        prevWord = text.slice(i, j);
        prevSig = "a";
        i = j;
      } else {
        if (c === "(") open(i);
        else if (c === ")") close(i);
        else if (c === "{" && typeof top === "number") modes[modes.length - 1] = top + 1;
        else if (c === "}" && typeof top === "number") {
          if (top === 0) modes.pop();
          else modes[modes.length - 1] = top - 1;
        }
        if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
          prevSig = c;
          prevWord = "";
        }
        i++;
      }
    }
  } else {
    while (i < n) {
      const c = text[i];
      const d = text[i + 1];
      if (c === "-" && d === "-") {
        let e = text.indexOf("\n", i);
        if (e < 0) e = n;
        blank(i, e);
        i = e;
      } else if (c === "/" && d === "*") {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (text[j] === "/" && text[j + 1] === "*") {
            depth++;
            j += 2;
          } else if (text[j] === "*" && text[j + 1] === "/") {
            depth--;
            j += 2;
          } else j++;
        }
        blank(i, j);
        i = j;
      } else if (c === "'") {
        const p = text[i - 1];
        const isE = (p === "E" || p === "e") && !/[\w]/.test(text[i - 2] ?? " ");
        let j = i + 1;
        while (j < n) {
          if (isE && text[j] === "\\") j += 2;
          else if (text[j] === "'") {
            if (text[j + 1] === "'") j += 2;
            else {
              j++;
              break;
            }
          } else j++;
        }
        i = j;
      } else if (c === '"') {
        let j = i + 1;
        while (j < n) {
          if (text[j] === '"') {
            if (text[j + 1] === '"') j += 2;
            else {
              j++;
              break;
            }
          } else j++;
        }
        i = j;
      } else if (c === "$") {
        const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 40));
        i += m ? m[0].length : 1; // 달러 인용의 구분자만 건너뛰고 본문은 코드로 본다(함수 본문 검사를 위해)
      } else {
        if (c === "(") open(i);
        else if (c === ")") close(i);
        i++;
      }
    }
  }
  parts.push(text.slice(last));
  return { cleaned: parts.join(""), comments, open2close, close2open };
}

/** text[open] === "(" 일 때 짝이 맞는 ")" 까지의 안쪽 문자열. 못 찾거나 너무 길면 null. */
function balanced(ctx, open) {
  const c = open >= 0 ? ctx.open2close[open] : -1;
  return c < 0 ? null : ctx.t.slice(open + 1, c);
}

/** text[close] === ")" 일 때 짝이 맞는 "(" 의 위치(없으면 -1). */
function openOf(ctx, close) {
  return close >= 0 ? ctx.close2open[close] : -1;
}

function splitTop(args) {
  const out = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(from, i));
      from = i + 1;
    }
  }
  out.push(args.slice(from));
  return out;
}

// ── 규칙 구현 ───────────────────────────────────────────────────
const TS_ISH = /(?:_at\b|_ts\b|_time\b|\bcreated|\bupdated|\boccurred|\bnow\s*\(\s*\)|\btimestamp|\bsent_|\bpaid_|\bexpires?_|\bcurrent_timestamp|(?:^|[."])ts\b)/i;
const DATE_OPTION_KEYS = /\b(?:year|month|day|hour|minute|second|weekday|dateStyle|timeStyle|timeZoneName|hour12|hourCycle|era|dayPeriod|fractionalSecondDigits)\s*:/;
const DATEISH_RECEIVER = /(date|time|_at|At$|created|updated|now|day)/i;
const TSISH_NAME = /(?:_at|At|Date|date|Time|time|created|Created|updated|Updated|timestamp|Timestamp)\w{0,12}$/;

/** SQL: 서울로 변환했는가. 서울이 아닌 «문자열 상수» 시간대는 변환이 아니다. 변수 시간대는 알 수 없으니 통과시킨다. */
function sqlSeoulOk(args) {
  if (/Asia\/Seoul|\bkst_\w+\s*\(/i.test(args)) return true;
  if (/at\s+time\s+zone\s*'/i.test(args)) return false;
  return /at\s+time\s+zone/i.test(args);
}

/** TS: timeZone 옵션 판정. "none" = 없음, "ok", "bad" = 서울이 아닌 상수, "unknown" = 변수라 알 수 없음. */
function tsTimeZone(args) {
  const m = /\btimeZone\s*:\s*([^,}\n]*)/.exec(args);
  if (!m) return /\.\.\./.test(args) ? "unknown" : "none";
  const v = m[1].trim();
  if (/^["'`]/.test(v)) return /^["'`]Asia\/Seoul["'`]$/.test(v) ? "ok" : "bad";
  return /^[A-Za-z_$][\w$.]*$/.test(v) ? "ok" : "unknown"; // 상수·변수 이름은 값을 알 수 없으니 통과시킨다
}

/**
 * 한 규칙의 모든 매치를 훑는다. check(m) 은 true(기본 심각도)·"error"|"warn"·null(통과) 을 돌려준다.
 * 위반 범위는 매치 시작부터, 매치에 호출 괄호가 있으면 그 닫는 괄호까지다(변경분 모드에서 여러 줄 호출을 다루기 위함).
 */
function scanRule(ctx, re, ruleId, check, out) {
  const t = ctx.t;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const sev = check(m);
    if (sev === null) continue;
    let end = m.index + m[0].length;
    const open = t.indexOf("(", m.index);
    if (open >= 0 && open < end) {
      const c = ctx.open2close[open];
      if (c >= 0 && c + 1 > end) end = c + 1;
    }
    out.push({ index: m.index, end, rule: ruleId, severity: sev === true ? RULE_BY_ID.get(ruleId).severity : sev });
  }
}

const always = () => true;
const FIELDS = "getFullYear|getMonth|getDate|getDay|getHours";

function runTsRules(ctx, out) {
  const t = ctx.t;
  const iso = "(?:toISOString|toJSON)\\(\\s*\\)\\s*\\??\\.\\s*";
  scanRule(ctx, new RegExp(`${iso}(?:slice|substring|substr)\\(\\s*0\\s*,\\s*(?:7|10)\\s*\\)`, "g"), "ts-iso-slice", always, out);
  scanRule(ctx, new RegExp(`${iso}split\\(\\s*["'\`]T["'\`]\\s*\\)\\s*(?:\\[\\s*0\\s*\\]|\\??\\.\\s*at\\(\\s*0\\s*\\))`, "g"), "ts-iso-slice", always, out);
  scanRule(ctx, new RegExp(`\\[\\s*\\w+\\s*\\]\\s*=[^;\\n]{0,120}toISOString\\(\\s*\\)\\s*\\.\\s*split\\(\\s*["'\`]T["'\`]\\s*\\)`, "g"), "ts-iso-slice", always, out);

  scanRule(ctx, new RegExp(`\\.\\s*(?:${FIELDS})\\s*(?:\\?\\.\\s*)?\\(|\\[\\s*["'\`](?:${FIELDS})["'\`]\\s*\\]\\s*\\(`, "g"), "ts-local-getters", always, out);

  scanRule(
    ctx,
    /\b(toLocaleDateString|toLocaleTimeString|toLocaleString)\s*\(|\bIntl\s*\.\s*DateTimeFormat\s*\(/g,
    "ts-locale-no-tz",
    (m) => {
      const args = balanced(ctx, m.index + m[0].length - 1);
      if (args === null) return "warn";
      const tz = tsTimeZone(args);
      if (tz === "ok") return null;
      if (tz === "bad") return true;
      if (tz === "unknown") return "warn";
      if (m[1] === "toLocaleString" && !DATE_OPTION_KEYS.test(args)) {
        // 숫자에도 쓰는 메서드라 «날짜로 보이는 수신자»일 때만 경고한다.
        const before = t.slice(Math.max(0, m.index - LOOKBACK), m.index);
        const recv = /([\w$]+)\s*\??\.\s*$/.exec(before);
        if (recv) return DATEISH_RECEIVER.test(recv[1]) ? "warn" : null;
        const closeAt = /\)\s*\??\.\s*$/.exec(before);
        if (closeAt) {
          const closeIdx = m.index - (before.length - before.lastIndexOf(")"));
          const o = openOf(ctx, closeIdx);
          if (o >= 0 && /new\s+Date\s*$/.test(t.slice(Math.max(0, o - 12), o))) return "warn";
        }
        return null;
      }
      const second = splitTop(args)[1];
      if (second !== undefined && !second.trim().startsWith("{")) return "warn";
      return true;
    },
    out,
  );

  scanRule(
    ctx,
    /\bnew\s+Date\s*\(/g,
    "ts-local-ctor",
    (m) => {
      const args = balanced(ctx, m.index + m[0].length - 1);
      if (args === null) return null;
      const parts = splitTop(args);
      if (parts.length >= 2) return /Date\.UTC/.test(args) ? null : true;
      return /^\s*["'`]\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?["'`]\s*$/.test(args) ? true : null;
    },
    out,
  );
  scanRule(ctx, /\.\s*(?:setHours|setDate|setMonth|setFullYear)\s*\(/g, "ts-local-ctor", always, out);

  // 시각처럼 보이는 이름의 앞 10자 자르기
  const sliceRe = /\??\.\s*(?:(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)|split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\])/g;
  scanRule(
    ctx,
    sliceRe,
    "ts-ts-slice",
    (m) => {
      const before = t.slice(Math.max(0, m.index - LOOKBACK), m.index);
      let name = "";
      const id = /([\w$]+)\s*!?\s*$/.exec(before);
      if (id) name = id[1];
      else if (/\)\s*$/.test(before)) {
        const closeIdx = m.index - (before.length - before.lastIndexOf(")"));
        const o = openOf(ctx, closeIdx);
        if (o >= 0 && /\bString\s*$/.test(t.slice(Math.max(0, o - 8), o))) name = (/([\w$]+)\s*!?\s*$/.exec(t.slice(o + 1, closeIdx)) ?? [])[1] ?? "";
      }
      return name !== "" && TSISH_NAME.test(name) ? true : null;
    },
    out,
  );
}

function runSqlRules(ctx, out) {
  const t = ctx.t;
  const nowFn = "(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)";
  scanRule(
    ctx,
    new RegExp(
      [
        "\\bcurrent_date\\b",
        "\\blocaltimestamp\\b",
        "\\blocaltime\\b",
        "\\bcurrent_time\\b",
        `\\b${nowFn}\\s*\\(\\s*\\)\\s*\\)?\\s*::\\s*(?:timestamp\\s*::\\s*)?date\\b`,
        "\\bcurrent_timestamp\\s*(?:\\(\\s*\\d?\\s*\\)\\s*)?::\\s*date\\b",
        `\\bdate\\s*\\(\\s*${nowFn}\\s*\\(\\s*\\)\\s*\\)`,
        `\\bcast\\s*\\(\\s*${nowFn}\\s*\\(\\s*\\)\\s+as\\s+date\\s*\\)`,
        "'(?:today|now)'\\s*::\\s*date\\b",
      ].join("|"),
      "gi",
    ),
    "sql-current-date",
    always,
    out,
  );

  scanRule(
    ctx,
    /\bdate_trunc\s*\(/gi,
    "sql-date-trunc",
    (m) => {
      const args = balanced(ctx, m.index + m[0].length - 1);
      if (args === null) return true;
      const unit = splitTop(args)[0].trim();
      if (/^'(?:hour|minute|second|millisecond|microsecond)s?'$/i.test(unit)) return null;
      return sqlSeoulOk(args) ? null : true;
    },
    out,
  );

  scanRule(
    ctx,
    /\b(?:extract|date_part)\s*\(/gi,
    "sql-extract",
    (m) => {
      const args = balanced(ctx, m.index + m[0].length - 1);
      if (args === null) return "warn";
      if (sqlSeoulOk(args) || /\binterval\b/i.test(args) || /^\s*'?epoch\b/i.test(args)) return null;
      return TS_ISH.test(args) ? true : "warn";
    },
    out,
  );

  // 구간 비교: 날짜 인자를 ::timestamptz 로 바꾸는 곳. 앞쪽 토큰을 짧은 창에서만 본다(선형).
  const argLike = /^(?:p_\w+|\w*_(?:from|to|start|end)|(?:from|to|since|until|start|end)\w*)$/i;
  const SKIP_TOKENS = new Set(["date", "interval", "day", "days", "hour", "hours", "month", "months", "year", "years", "week", "weeks", "timestamp", "with", "time", "zone", "as"]);
  const lastArgToken = (idx) => {
    let from = Math.max(0, idx - LOOKBACK);
    const semi = t.slice(from, idx).lastIndexOf(";");
    if (semi >= 0) from += semi + 1;
    const toks = (t.slice(from, idx).match(/[A-Za-z_]\w*/g) ?? []).filter((x) => !SKIP_TOKENS.has(x.toLowerCase()));
    return toks.length > 0 ? toks[toks.length - 1] : "";
  };
  scanRule(ctx, /::\s*(?:timestamptz\b|timestamp\s+with\s+time\s+zone\b)/gi, "sql-range-cast", (m) => (argLike.test(lastArgToken(m.index)) ? true : null), out);
  scanRule(
    ctx,
    /\bcast\s*\(/gi,
    "sql-range-cast",
    (m) => {
      const args = balanced(ctx, m.index + m[0].length - 1);
      if (args === null) return null;
      const mm = /^\s*([\w.]+)(?:\s*::\s*date)?\s+as\s+(?:timestamptz|timestamp\s+with\s+time\s+zone)\s*$/i.exec(args);
      return mm && argLike.test(mm[1]) ? true : null;
    },
    out,
  );
  scanRule(ctx, /'\d{4}-\d{2}-\d{2}'\s*::\s*timestamptz\b/gi, "sql-range-cast", () => "warn", out);

  // 시각 열을 날짜로 자르기: ::date, date(...), cast(.. as date)
  scanRule(
    ctx,
    /::\s*date\b/gi,
    "sql-ts-cast-date",
    (m) => {
      const before = t.slice(Math.max(0, m.index - LOOKBACK), m.index);
      if (/\)\s*$/.test(before)) {
        const closeIdx = m.index - (before.length - before.lastIndexOf(")"));
        const o = openOf(ctx, closeIdx);
        if (o < 0) return null;
        const inner = t.slice(o + 1, closeIdx);
        if (sqlSeoulOk(inner)) return null;
        return TS_ISH.test(inner) ? true : null;
      }
      const id = /("?[A-Za-z_][\w."]*)\s*$/.exec(before);
      return id && TS_ISH.test(id[1].replace(/"/g, "")) ? true : null;
    },
    out,
  );
  scanRule(
    ctx,
    /\b(?:date|cast)\s*\(/gi,
    "sql-ts-cast-date",
    (m) => {
      const args = balanced(ctx, m.index + m[0].length - 1);
      if (args === null || sqlSeoulOk(args)) return null;
      if (/^date/i.test(m[0])) return TS_ISH.test(args) && !/\bas\b/i.test(args) ? true : null;
      return /\bas\s+date\s*$/i.test(args) && TS_ISH.test(args) ? true : null;
    },
    out,
  );

  scanRule(
    ctx,
    /\bto_char\s*\(/gi,
    "sql-to-char-date",
    (m) => {
      const args = balanced(ctx, m.index + m[0].length - 1);
      if (args === null || sqlSeoulOk(args)) return null;
      return TS_ISH.test(args) && /YYYY|DD|HH24|HH12|MM/i.test(args) ? true : null;
    },
    out,
  );
}

// ── 허용 목록 ───────────────────────────────────────────────────
const DIRECTIVE_RE = /kst-ok:\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)(?:[ \t]+(.*))?$/;
const REASON_RE = /[\p{L}\p{N}]{2,}/u;

/** 주석 안에서만 `kst-ok:` 를 찾는다(문자열·코드 안의 같은 글자는 무시). */
function parseDirectives(raw, starts, cleanedLines, comments) {
  const list = [];
  for (const [s, e] of comments) {
    const body = raw.slice(s, e);
    let offset = 0;
    for (const lineText of body.split("\n")) {
      const at = lineText.indexOf("kst-ok:");
      if (at >= 0) {
        const m = DIRECTIVE_RE.exec(lineText.slice(at));
        if (m) {
          const lineNo = lineOf(starts, s + offset) + 1;
          const endLine = lineOf(starts, e - 1) + 1;
          list.push({
            ids: m[1].split(/\s*,\s*/).filter(Boolean),
            reason: (m[2] ?? "").replace(/\*\/\s*$/, "").trim(),
            lineNo,
            appliesTo: new Set(cleanedLines[endLine - 1].trim() === "" ? [lineNo, endLine + 1] : [lineNo]),
          });
        }
      }
      offset += lineText.length + 1;
    }
  }
  return list;
}

function globToRegExp(glob) {
  const g = normPath(glob);
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
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** 글롭이 경로와 정확히 맞는가(allow 용: 폴더 접두어로는 맞지 않는다). */
const globMatch = (glob, rel) => globToRegExp(glob).test(rel);

/** exclude 용: 경로 자체 또는 상위 폴더가 글롭에 맞으면 제외. */
function pathExcluded(glob, rel) {
  const re = globToRegExp(glob);
  if (re.test(rel)) return true;
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) if (re.test(parts.slice(0, i).join("/"))) return true;
  return false;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
function isRealDate(s) {
  const m = YMD.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 서울 오늘(YYYY-MM-DD). 시계 주입 가능. */
export function seoulToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); // kst-ok: ts-iso-slice +9시간 보정 후 슬라이스(검사기 자체의 날짜 판정)
}

/**
 * 설정 객체 검증. 잘못된 항목은 problems 에, 유효한 항목은 entries 에 담는다.
 * @returns {{entries: Array<{file:string, rule:string, match:string, reason:string, expires?:string, expired:boolean, used:boolean, index:number}>, exclude:string[], problems:Array<{index:number, why:string}>}}
 */
export function parseConfig(config, today = seoulToday()) {
  const entries = [];
  const problems = [];
  const exclude = [];
  const cfg = config && typeof config === "object" ? config : {};
  if (Array.isArray(cfg.exclude)) for (const g of cfg.exclude) if (typeof g === "string" && g) exclude.push(normPath(g));
  const allow = Array.isArray(cfg.allow) ? cfg.allow : [];
  allow.forEach((e, index) => {
    const ok =
      e &&
      typeof e === "object" &&
      typeof e.file === "string" && e.file.length > 0 &&
      typeof e.rule === "string" && RULE_BY_ID.has(e.rule) &&
      typeof e.match === "string" && e.match.trim().length > 0 &&
      typeof e.reason === "string" && REASON_RE.test(e.reason) &&
      (e.expires === undefined || (typeof e.expires === "string" && isRealDate(e.expires)));
    if (!ok) {
      problems.push({ index, why: "invalid" });
      return;
    }
    entries.push({
      file: normPath(e.file),
      rule: e.rule,
      match: squash(e.match),
      reason: e.reason.trim(),
      ...(e.expires ? { expires: e.expires } : {}),
      expired: e.expires !== undefined && e.expires < today,
      used: false,
      index,
    });
  });
  return { entries, exclude, problems };
}

/** 설정 파일의 모양 점검. 오타로 규칙이 조용히 꺼지지 않도록 모르는 키는 오류로 본다. */
function assertConfigShape(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("설정 파일의 최상위는 객체여야 한다.");
  for (const k of Object.keys(config)) if (k !== "allow" && k !== "exclude") throw new Error(`설정 파일에 모르는 키가 있다: ${k} (허용: allow, exclude)`);
  if (config.allow !== undefined && !Array.isArray(config.allow)) throw new Error("설정의 allow 는 배열이어야 한다.");
  if (config.exclude !== undefined && (!Array.isArray(config.exclude) || config.exclude.some((g) => typeof g !== "string"))) throw new Error("설정의 exclude 는 문자열 배열이어야 한다.");
}

// ── 파일 하나 검사 ──────────────────────────────────────────────
/**
 * @param {{file:string, text:string, entries?:ReturnType<typeof parseConfig>["entries"]}} p
 * @returns {{findings:Array<{file:string,line:number,endLine:number,col:number,rule:string,severity:string,message:string,text:string}>, suppressed:number}}
 */
export function checkSource(p) {
  const file = normPath(p.file);
  const lang = langOf(file);
  if (!lang) return { findings: [], suppressed: 0 };
  const raw = normalizeNewlines(p.text);
  const rawLines = raw.split("\n");
  const starts = lineStarts(raw);
  const lx = lex(raw, lang);
  const cleanedLines = lx.cleaned.split("\n");
  const ctx = { t: lx.cleaned, open2close: lx.open2close, close2open: lx.close2open };
  const hits = [];
  if (lang === "ts") runTsRules(ctx, hits);
  else runSqlRules(ctx, hits);

  const directives = parseDirectives(raw, starts, cleanedLines, lx.comments);
  const fileEntries = (p.entries ?? []).filter((e) => !e.expired && globMatch(e.file, file));
  const squashCache = new Map();
  const findings = [];
  let suppressed = 0;

  const make = (rule, severity, line, col, endLine = line) => ({
    file,
    line,
    endLine,
    col,
    rule,
    severity,
    message: RULE_BY_ID.get(rule).message,
    text: (rawLines[line - 1] ?? "").slice(0, 400).trim().slice(0, 200),
  });

  for (const d of directives) {
    if (!REASON_RE.test(d.reason)) findings.push(make("kst-ok-no-reason", "error", d.lineNo, 1));
    for (const id of d.ids) if (!RULE_BY_ID.has(id)) findings.push(make("kst-ok-unknown-rule", "warn", d.lineNo, 1));
  }

  const seen = new Set();
  for (const h of hits) {
    const key = `${h.rule}:${h.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = lineOf(starts, h.index) + 1;
    const col = h.index - starts[line - 1] + 1;
    const endLine = lineOf(starts, Math.max(h.index, h.end - 1)) + 1;

    if (directives.some((d) => REASON_RE.test(d.reason) && d.ids.includes(h.rule) && d.appliesTo.has(line))) {
      suppressed++;
      continue;
    }

    if (fileEntries.length > 0) {
      let lineSquash = squashCache.get(line);
      if (lineSquash === undefined) {
        lineSquash = squash(rawLines[line - 1] ?? "");
        squashCache.set(line, lineSquash);
      }
      const entry = fileEntries.find((e) => e.rule === h.rule && e.match === lineSquash);
      if (entry) {
        entry.used = true;
        suppressed++;
        continue;
      }
    }
    findings.push(make(h.rule, h.severity, line, col, endLine));
  }
  return { findings, suppressed };
}

// ── 파일 수집 ───────────────────────────────────────────────────
function walk(root, startRel, exclude, out, top = true) {
  const abs = path.join(root, startRel);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  const rel = normPath(startRel);
  if (rel !== "" && exclude.some((g) => pathExcluded(g, rel))) return;
  if (st.isFile()) {
    if (langOf(rel)) out.push(rel);
    return;
  }
  if (!st.isDirectory()) return;
  if (!top && DEFAULT_EXCLUDE_DIRS.has(path.basename(abs))) return; // 직접 지정한 시작 폴더는 기본 제외 목록과 무관하게 훑는다
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    walk(root, startRel === "" ? ent.name : `${startRel}/${ent.name}`, exclude, out, false);
  }
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** 바뀐 파일과 바뀐 줄(새 파일 기준). 값이 true 면 파일 전체. 지워진 줄 자리는 앞뒤 두 줄을 «바뀐 줄»로 본다. */
function changedFiles(root, ref, scope, exclude) {
  if (ref.startsWith("-")) throw new Error(`기준 브랜치 이름이 옵션처럼 보인다: ${ref}`);
  let base;
  try {
    base = git(root, ["merge-base", ref, "HEAD"]).trim();
  } catch {
    throw new Error(`git merge-base ${ref} HEAD 실패: 기준 브랜치가 없거나 git 저장소가 아니다(CI 는 fetch-depth: 0 또는 기준 브랜치 fetch 가 필요하다).`);
  }
  const keep = (rel) => langOf(rel) && !exclude.some((g) => pathExcluded(g, rel)) && !rel.split("/").some((s) => DEFAULT_EXCLUDE_DIRS.has(s));
  const scopeArgs = scope.length > 0 ? ["--", ...scope] : [];
  const changed = new Map();
  const tok = git(root, ["-c", "core.quotepath=false", "diff", "--relative", "--name-status", "-z", "-M", "--diff-filter=ACMR", base, ...scopeArgs]).split("\0");
  for (let i = 0; i < tok.length; ) {
    const status = tok[i++];
    if (!status) continue;
    const kind = status[0];
    const oldPath = kind === "R" || kind === "C" ? tok[i++] : null;
    const newPath = tok[i++];
    if (!newPath) continue;
    const rel = normPath(newPath);
    if (!keep(rel)) continue;
    if (kind === "A" || kind === "C") {
      changed.set(rel, true);
      continue;
    }
    if (status === "R100") continue; // 이름만 바뀜
    const specs = oldPath ? [oldPath, newPath] : [newPath];
    const diff = git(root, ["-c", "core.quotepath=false", "diff", "--relative", "-U0", "--no-color", "-M", base, "--", ...specs]);
    const lines = new Set();
    const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let m;
    while ((m = re.exec(diff)) !== null) {
      const startLine = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0) {
        lines.add(Math.max(1, startLine));
        lines.add(startLine + 1);
      } else for (let k = 0; k < count; k++) lines.add(startLine + k);
    }
    changed.set(rel, lines);
  }
  for (const n of git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...scopeArgs]).split("\0").filter(Boolean)) {
    const rel = normPath(n);
    if (keep(rel)) changed.set(rel, true);
  }
  return changed;
}

// ── CLI ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { root: process.cwd(), config: null, all: false, since: null, warnOnly: false, json: false, help: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      i++;
      if (i >= argv.length) throw new Error(`${name} 값이 없다`);
      return argv[i];
    };
    if (a === "--all") o.all = true;
    else if (a === "--warn-only") o.warnOnly = true;
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--root" || a.startsWith("--root=")) o.root = path.resolve(val("--root"));
    else if (a === "--config" || a.startsWith("--config=")) o.config = val("--config");
    else if (a === "--changed-since" || a.startsWith("--changed-since=")) o.since = val("--changed-since");
    else if (a.startsWith("--")) throw new Error(`알 수 없는 옵션: ${a}`);
    else o.paths.push(a);
  }
  if (o.all && o.since !== null) throw new Error("--all 과 --changed-since 는 함께 쓸 수 없다.");
  return o;
}

const HELP = `서울 날짜 규칙 정적 검사
  node check.mjs [--root DIR] [--config FILE] [--all | --changed-since REF] [--warn-only] [--json] [PATH...]
  기본: --changed-since origin/main (바뀐 줄만). --all 은 전수 점검. 설정 파일 기본값: <root>/.kst-check.json
  종료 코드: 0 통과 / 1 error 있음 / 2 사용법·설정·경로·git 오류`;

/**
 * @param {string[]} argv
 * @param {{out?:(s:string)=>void, err?:(s:string)=>void, today?:string}} [io]
 * @returns {number} 종료 코드
 */
export function run(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  try {
    const o = parseArgs(argv);
    if (o.help) {
      out(HELP);
      return 0;
    }
    if (!existsSync(o.root) || !statSync(o.root).isDirectory()) throw new Error(`--root 폴더가 없다: ${o.root}`);
    const scope = o.paths.map((p) => {
      const rel = path.isAbsolute(p) ? path.relative(o.root, p) : p;
      const n = normPath(rel);
      if (n === ".." || n.startsWith("../")) throw new Error(`검사 경로가 --root 밖이다: ${p}`);
      if (!existsSync(path.join(o.root, n))) throw new Error(`검사 경로가 없다: ${p}`);
      return n === "" ? "." : n;
    });
    const today = io.today ?? seoulToday();
    const cfgPath = o.config ? path.resolve(o.root, o.config) : path.join(o.root, ".kst-check.json");
    let config = {};
    if (existsSync(cfgPath)) {
      try {
        config = JSON.parse(readFileSync(cfgPath, "utf8").replace(/^﻿/, ""));
      } catch {
        throw new Error(`설정 파일을 읽을 수 없다(JSON 오류): ${cfgPath}`);
      }
      assertConfigShape(config);
    } else if (o.config) {
      throw new Error(`설정 파일이 없다: ${cfgPath}`);
    }
    const cfg = parseConfig(config, today);
    const mode = o.all ? "all" : "changed";
    const ref = o.since ?? "origin/main";

    /** @type {Map<string, Set<number>|true>} */
    let targets;
    if (mode === "all") {
      const files = [];
      if (scope.length === 0) walk(o.root, "", cfg.exclude, files);
      else for (const s of scope) walk(o.root, s === "." ? "" : s, cfg.exclude, files);
      targets = new Map(files.map((f) => [f, true]));
    } else {
      targets = changedFiles(o.root, ref, scope, cfg.exclude);
    }

    const findings = [];
    let suppressed = 0;
    let scanned = 0;
    const skipped = (rel, text) => findings.push({ file: rel, line: 1, endLine: 1, col: 1, rule: "kst-file-skipped", severity: "warn", message: RULE_BY_ID.get("kst-file-skipped").message, text });
    for (const [rel, lines] of [...targets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const abs = path.join(o.root, rel);
      let size;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        skipped(rel, `${size} bytes`);
        continue;
      }
      const buf = readFileSync(abs);
      if (buf.includes(0)) {
        skipped(rel, "UTF-8 텍스트가 아니다(UTF-16 등)");
        continue;
      }
      scanned++;
      const r = checkSource({ file: rel, text: buf.toString("utf8").replace(/^﻿/, ""), entries: cfg.entries });
      suppressed += r.suppressed;
      for (const f of r.findings) {
        if (lines === true) findings.push(f);
        else {
          for (let l = f.line; l <= f.endLine; l++) {
            if (lines.has(l)) {
              findings.push(f);
              break;
            }
          }
        }
      }
    }

    // 설정 위생(만료·잘못된 항목은 항상, 미사용은 --all 에서만)
    const where = normPath(path.relative(o.root, cfgPath));
    const cfgFinding = (rule, index, text) => findings.push({ file: where, line: index + 1, endLine: index + 1, col: 1, rule, severity: RULE_BY_ID.get(rule).severity, message: RULE_BY_ID.get(rule).message, text });
    for (const p of cfg.problems) cfgFinding("kst-allow-invalid", p.index, `allow[${p.index}]`);
    for (const e of cfg.entries) {
      if (e.expired) cfgFinding("kst-allow-expired", e.index, `allow[${e.index}] ${e.rule} ${e.file} (expires ${e.expires})`);
      else if (mode === "all" && !e.used) cfgFinding("kst-allow-unused", e.index, `allow[${e.index}] ${e.rule} ${e.file}`);
    }

    const errors = findings.filter((f) => f.severity === "error").length;
    const warns = findings.length - errors;
    if (o.json) {
      out(JSON.stringify({ mode, scanned, suppressed, errors, warns, findings }, null, 2));
    } else {
      for (const f of findings) out(`${f.file}:${f.line}:${f.col}  ${f.severity}  ${f.rule}  ${f.message}${f.text ? `\n    ${f.text}` : ""}`);
      out(`kst-check(${mode}${mode === "changed" ? ` ${ref}` : ""}): 파일 ${scanned}개 검사, error ${errors}, warn ${warns}, 허용으로 제외 ${suppressed}${o.warnOnly ? " (warn-only)" : ""}`);
    }
    return errors > 0 && !o.warnOnly ? 1 : 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

// 링크(정션·심볼릭)로 실행해도 실제 파일로 비교한다. 비교가 어긋나면 «검사 없이 종료 0» 이 되므로 모르는 경우엔 실행하는 쪽으로 기운다.
const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();
if (isMain) process.exitCode = run(process.argv.slice(2));
