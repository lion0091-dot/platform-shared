import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RULES, checkSource, parseConfig, run } from "./check.mjs";

// 모든 입력은 합성값이다. 현재 시각·시간대에 의존하지 않는다(만료 판정도 today 를 주입).

const ids = (file: string, text: string, entries = parseConfig({}).entries) => checkSource({ file, text, entries }).findings.map((f) => f.rule);
const sev = (file: string, text: string, rule: string) => checkSource({ file, text }).findings.find((f) => f.rule === rule)?.severity;

interface Sample {
  rule: string;
  file: string;
  severity: "error" | "warn";
  bad: string[];
  ok: string[];
}

const SAMPLES: Sample[] = [
  {
    rule: "ts-iso-slice",
    file: "a.ts",
    severity: "error",
    bad: [
      "const d = new Date().toISOString().slice(0, 10);",
      'const d = x.toISOString().split("T")[0];',
      "const d = x.toISOString()\n  .substring(0,10);",
      "const m = x.toISOString().slice(0, 7);",
      "const d = x.toISOString()?.slice(0, 10);",
      "const d = x.toISOString( ).slice(0, 10);",
      'const d = x.toISOString().split("T").at(0);',
      'const [d] = x.toISOString().split("T");',
      "const d = x.toJSON().slice(0, 10);",
    ],
    ok: ["const d = kstToday();", "const t = x.toISOString();", "const d = x.toISOString().slice(0, 4);"],
  },
  {
    rule: "ts-local-getters",
    file: "a.ts",
    severity: "error",
    bad: ["const y = d.getFullYear();", "const m = d?.getMonth ();", "const h = d.getHours()", 'const y = d["getFullYear"]();', "const y = d.getFullYear?.();"],
    ok: ["const y = d.getUTCFullYear();", "const n = map.get(key);", "const y = kstMonth(d);"],
  },
  {
    rule: "ts-locale-no-tz",
    file: "a.tsx",
    severity: "error",
    bad: [
      'const s = d.toLocaleDateString("ko-KR");',
      'const s = d.toLocaleDateString("ko-KR", { timeZone: "UTC" });',
      'const s = d.toLocaleString("ko-KR", { timeZoneName: "short" });',
      'const s = d.toLocaleString("ko-KR", { year: "numeric", timeZoneName: "short" });',
      'const s = d.toLocaleTimeString("ko-KR", { hour: "2-digit" });',
      'const f = new Intl.DateTimeFormat("ko-KR", { year: "numeric" });',
      'const s = d.toLocaleString("ko-KR", {\n  month: "long",\n  day: "numeric",\n});',
    ],
    ok: [
      'const s = d.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });',
      'const f = new Intl.DateTimeFormat("ko-KR", {\n  year: "numeric",\n  timeZone: "Asia/Seoul",\n});',
      'const s = (1234.5).toLocaleString("ko-KR");',
      "const s = price.toLocaleString();",
      'const s = d.toLocaleDateString("ko-KR", { timeZone: KST_TZ });',
    ],
  },
  {
    rule: "ts-local-ctor",
    file: "a.ts",
    severity: "warn",
    bad: ["const d = new Date(2026, 10, 1);", "d.setHours(0, 0, 0, 0);", "d.setDate(d.getUTCDate() + 1);", 'const d = new Date("2026-11-01T00:00:00");', "const d = new Date(year, month - 1, Number(day));"],
    ok: ["const d = new Date(Date.UTC(2026, 10, 1));", 'const d = new Date("2026-11-01T00:00:00+09:00");', "const d = new Date(ms);"],
  },
  {
    rule: "ts-ts-slice",
    file: "a.ts",
    severity: "warn",
    bad: [
      "const d = row.created_at.slice(0, 10);",
      "const d = order.createdAt?.slice(0, 10);",
      "const d = issueDate.substring(0, 10);",
      'const d = row.created_at.split("T")[0];',
      "const d = row.created_at!.slice(0, 10);",
      "const d = String(row.created_at).slice(0, 10);",
      "const d = row.created.slice(0, 10);",
      "const d = row.timestamp.substr(0, 10);",
    ],
    ok: ["const s = name.slice(0, 10);", "const d = row.created_at.slice(0, 7);"],
  },
  {
    rule: "sql-current-date",
    file: "m.sql",
    severity: "error",
    bad: [
      "select current_date;",
      "select now()::date;",
      "select CURRENT_TIMESTAMP :: date;",
      "select localtimestamp;",
      "select clock_timestamp()::date;",
      "select statement_timestamp()::date;",
      "select date(now());",
      "select 'today'::date;",
      "select current_timestamp(0)::date;",
      "select localtime;",
      "select (now())::date;",
      "select cast(now() as date);",
      "select now()::timestamp::date;",
    ],
    ok: ["select (now() at time zone 'Asia/Seoul')::date;", "select kst_today();", "-- current_date 는 쓰지 않는다\nselect 1;", "/* now()::date */ select 1;"],
  },
  {
    rule: "sql-date-trunc",
    file: "m.sql",
    severity: "error",
    bad: [
      "select date_trunc('month', created_at) from t;",
      "select DATE_TRUNC( 'day' , x ) from t;",
      "select date_trunc(p_unit, created_at) from t;",
      "select date_trunc('month', created_at at time zone 'UTC') from t;",
    ],
    ok: [
      "select date_trunc('month', created_at at time zone 'Asia/Seoul') from t;",
      "select date_trunc('day', created_at, 'Asia/Seoul') from t;",
      "select date_trunc('hour', created_at) from t;",
      "select date_trunc('month', kst_today()) from t;",
    ],
  },
  {
    rule: "sql-extract",
    file: "m.sql",
    severity: "error",
    bad: [
      "select extract(hour from created_at) from t;",
      "select date_part('hour', updated_at) from t;",
      "select extract(hour from created_at at time zone 'America/New_York') from t;",
    ],
    ok: ["select extract(hour from created_at at time zone 'Asia/Seoul') from t;", "select extract(epoch from interval '1 day');"],
  },
  {
    rule: "sql-range-cast",
    file: "m.sql",
    severity: "error",
    bad: [
      "where created_at >= p_from::timestamptz",
      "where created_at < (p_to + 1)::timestamptz",
      "where created_at < (p_to::date + 1)::timestamptz",
      "where d >= from_date::timestamptz",
      "where created_at < (p_to + interval '1 day')::timestamptz",
      "where created_at >= cast(p_from as timestamptz)",
      "where created_at >= p_from::timestamp with time zone",
      "where created_at >= start_date::timestamptz and x < end_date::timestamptz",
    ],
    ok: [
      "where created_at >= (p_from::timestamp at time zone 'Asia/Seoul')",
      "where created_at >= (p_to::timestamp at time zone 'Asia/Seoul')",
      "where created_at >= (kst_day_range(p_from)).from_ts",
      "select p_total::numeric;",
    ],
  },
  {
    rule: "sql-ts-cast-date",
    file: "m.sql",
    severity: "warn",
    bad: [
      "select created_at::date from t;",
      "select r.updated_at ::date from t;",
      "select (created_at)::date from t;",
      "select cast(created_at as date) from t;",
      'select "created_at"::date from t;',
      "select date(created_at) from t;",
      "select (created_at at time zone 'UTC')::date from t;",
    ],
    ok: ["select (created_at at time zone 'Asia/Seoul')::date from t;", "select birth_date::date from t;", "select cast(birth_date as date) from t;", "select date(birth_date) from t;"],
  },
  {
    rule: "sql-to-char-date",
    file: "m.sql",
    severity: "warn",
    bad: ["select to_char(created_at, 'YYYY-MM-DD') from t;", "select to_char(created_at, 'yyyy-mm-dd') from t;", "select to_char(created_at, 'HH24') from t;"],
    ok: ["select to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') from t;", "select to_char(total, '999,999') from t;"],
  },
];

describe("규칙별 위반(잡힘)·허용(통과) 예시", () => {
  it("규칙 목록의 모든 코드 규칙이 시험된다", () => {
    const covered = new Set(SAMPLES.map((s) => s.rule));
    for (const r of RULES.filter((x) => x.lang !== "meta")) expect(covered.has(r.id), r.id).toBe(true);
  });

  for (const s of SAMPLES) {
    describe(s.rule, () => {
      s.bad.forEach((text, i) => {
        it(`위반 예시 ${i + 1} 가 잡힌다`, () => {
          expect(ids(s.file, text), text).toContain(s.rule);
          expect(sev(s.file, text, s.rule), text).toBe(s.severity);
        });
      });
      s.ok.forEach((text, i) => {
        it(`허용 예시 ${i + 1} 은 통과한다`, () => {
          expect(ids(s.file, text), text).not.toContain(s.rule);
        });
      });
    });
  }

  it("toLocale* 의 옵션이 변수면 단정하지 않고 warn", () => {
    expect(sev("a.ts", 'const s = d.toLocaleDateString("ko-KR", opts);', "ts-locale-no-tz")).toBe("warn");
  });

  it("날짜처럼 보이는 변수의 toLocaleString() 은 warn", () => {
    expect(sev("a.ts", "const s = createdAt.toLocaleString();", "ts-locale-no-tz")).toBe("warn");
  });

  it("extract 인데 시각 열이 아니면 warn", () => {
    expect(sev("m.sql", "select extract(year from some_date) from t;", "sql-extract")).toBe("warn");
  });

  it("리터럴 날짜의 ::timestamptz 는 warn", () => {
    expect(sev("m.sql", "where d >= '2026-11-01'::timestamptz", "sql-range-cast")).toBe("warn");
  });

  it("알 수 없는 확장자는 검사하지 않는다", () => {
    expect(ids("a.md", "select current_date; d.getDate()")).toEqual([]);
  });
});

describe("주석·문자열 처리", () => {
  it("주석 안의 패턴은 잡지 않는다(TS)", () => {
    expect(ids("a.ts", "// d.getDate() 는 쓰지 않는다\n/* x.toISOString().slice(0, 10) */\nconst a = 1;")).toEqual([]);
  });

  it("문자열 안의 // 는 주석이 아니다(뒤의 위반을 놓치지 않는다)", () => {
    expect(ids("a.ts", 'const u = "http://example.invalid"; const y = d.getFullYear();')).toContain("ts-local-getters");
  });

  it("SQL 문자열 안의 -- 는 주석이 아니다", () => {
    expect(ids("m.sql", "select '--', current_date;")).toContain("sql-current-date");
  });

  it("줄 번호는 주석 제거 뒤에도 유지된다", () => {
    const r = checkSource({ file: "m.sql", text: "/* a\nb\nc */\nselect current_date;" });
    expect(r.findings[0]).toMatchObject({ rule: "sql-current-date", line: 4 });
  });
});

describe("kst-ok 주석", () => {
  it("같은 줄 주석(사유 있음)이면 통과", () => {
    expect(ids("a.ts", "const d = x.toISOString().slice(0, 10); // kst-ok: ts-iso-slice 고정 시각 시험값")).toEqual([]);
  });

  it("윗줄이 주석만 있으면 다음 줄에 적용된다(TS·SQL·블록 주석)", () => {
    expect(ids("a.ts", "// kst-ok: ts-local-getters 로컬 달력 표시용\nconst y = d.getFullYear();")).toEqual([]);
    expect(ids("m.sql", "-- kst-ok: sql-current-date 로그 시각만 쓴다\nselect current_date;")).toEqual([]);
    expect(ids("m.sql", "/* kst-ok: sql-current-date 로그 시각만 */\nselect current_date;")).toEqual([]);
    expect(ids("m.sql", "select current_date; -- kst-ok: sql-current-date 로그 시각만")).toEqual([]);
  });

  it("두 줄 이상 떨어지면 적용되지 않는다", () => {
    expect(ids("m.sql", "-- kst-ok: sql-current-date 사유\n\nselect current_date;")).toContain("sql-current-date");
  });

  it("코드가 있는 윗줄의 주석은 다음 줄에 적용되지 않는다", () => {
    expect(ids("m.sql", "select 1; -- kst-ok: sql-current-date 사유\nselect current_date;")).toContain("sql-current-date");
  });

  it("사유가 없으면 실패한다(원래 위반도 그대로 남는다)", () => {
    const r = ids("a.ts", "const d = x.toISOString().slice(0, 10); // kst-ok: ts-iso-slice");
    expect(r).toContain("kst-ok-no-reason");
    expect(r).toContain("ts-iso-slice");
    expect(sev("a.ts", "const d = x.toISOString().slice(0, 10); // kst-ok: ts-iso-slice", "kst-ok-no-reason")).toBe("error");
  });

  it("다른 규칙의 kst-ok 로는 통과하지 않는다", () => {
    expect(ids("a.ts", "const d = x.toISOString().slice(0, 10); // kst-ok: ts-local-getters 사유")).toContain("ts-iso-slice");
  });

  it("쉼표로 여러 규칙을 한 번에 허용할 수 있다", () => {
    expect(ids("a.ts", "const d = x.getDate() + y.toISOString().slice(0, 10); // kst-ok: ts-local-getters,ts-iso-slice 사유")).toEqual([]);
  });

  it("알 수 없는 규칙 ID 는 warn", () => {
    const r = checkSource({ file: "a.ts", text: "const a = 1; // kst-ok: ts-bogus 사유" });
    expect(r.findings).toMatchObject([{ rule: "kst-ok-unknown-rule", severity: "warn" }]);
  });
});

describe("설정 allow 목록", () => {
  const TEXT = "select   current_date ;\nselect 1;";

  it("줄 텍스트 매칭은 공백을 무시한다", () => {
    const { entries } = parseConfig({ allow: [{ file: "supabase/migrations/a.sql", rule: "sql-current-date", match: "select current_date;", reason: "로그용" }] });
    expect(ids("supabase/migrations/a.sql", TEXT, entries)).toEqual([]);
    expect(entries[0]!.used).toBe(true);
  });

  it("매칭 줄 텍스트가 다르면 통과하지 않는다", () => {
    const { entries } = parseConfig({ allow: [{ file: "supabase/migrations/a.sql", rule: "sql-current-date", match: "select current_date, 1;", reason: "로그용" }] });
    expect(ids("supabase/migrations/a.sql", TEXT, entries)).toEqual(["sql-current-date"]);
  });

  it("윈도 경로 구분자·./ 접두·글롭을 같게 본다", () => {
    const mk = (file: string) => parseConfig({ allow: [{ file, rule: "sql-current-date", match: "select current_date;", reason: "사유 있음" }] }).entries;
    expect(ids("supabase/migrations/a.sql", TEXT, mk("supabase\\migrations\\a.sql"))).toEqual([]);
    expect(ids("supabase/migrations/a.sql", TEXT, mk("./supabase/migrations/a.sql"))).toEqual([]);
    expect(ids("supabase/migrations/a.sql", TEXT, mk("supabase/**/*.sql"))).toEqual([]);
    expect(ids("supabase\\migrations\\a.sql", TEXT, mk("supabase/migrations/a.sql"))).toEqual([]);
    expect(ids("supabase/migrations/b.sql", TEXT, mk("supabase/migrations/a.sql"))).toEqual(["sql-current-date"]);
  });

  it("규칙이 다르면 통과하지 않는다", () => {
    const { entries } = parseConfig({ allow: [{ file: "a.sql", rule: "sql-date-trunc", match: "select current_date;", reason: "사유 있음" }] });
    expect(ids("a.sql", "select current_date;", entries)).toEqual(["sql-current-date"]);
  });

  it("만료된 항목은 통과시키지 않는다(만료일 당일까지는 유효)", () => {
    const allow = [{ file: "a.sql", rule: "sql-current-date", match: "select current_date;", reason: "사유 있음", expires: "2026-11-12" }];
    expect(ids("a.sql", "select current_date;", parseConfig({ allow }, "2026-11-12").entries)).toEqual([]);
    expect(ids("a.sql", "select current_date;", parseConfig({ allow }, "2026-11-13").entries)).toEqual(["sql-current-date"]);
  });

  it("file·rule·match·reason 이 빠졌거나 expires 형식이 틀리면 invalid", () => {
    const base = { file: "a.sql", rule: "sql-current-date", match: "m", reason: "사유 있음" };
    const bad = [
      { ...base, reason: "" },
      { ...base, reason: undefined },
      { ...base, match: " " },
      { ...base, rule: "nope" },
      { ...base, file: "" },
      { ...base, expires: "2026-1-1" },
      { ...base, expires: "2026-02-31" },
      { ...base, expires: "9999-99-99" },
      { ...base, reason: "." },
      "string",
      null,
    ];
    const r = parseConfig({ allow: [...bad, base] });
    expect(r.problems).toHaveLength(bad.length);
    expect(r.entries).toHaveLength(1);
  });
});

describe("줄바꿈·인코딩", () => {
  it("CRLF 입력도 줄 번호와 kst-ok 가 맞는다", () => {
    const text = "select 1;\r\n-- kst-ok: sql-current-date 사유\r\nselect current_date;\r\nselect localtimestamp;\r\n";
    const r = checkSource({ file: "m.sql", text });
    expect(r.findings.map((f) => [f.rule, f.line])).toEqual([["sql-current-date", 4]]);
    expect(r.suppressed).toBe(1);
  });

  it("CR 단독은 줄바꿈이 아니다(git 의 줄 번호와 같게)", () => {
    expect(checkSource({ file: "a.ts", text: "a\rb\nd.getDate()" }).findings[0]!.line).toBe(2); // git 처럼 «\n» 만 줄바꿈
  });
});

// ── run(): 임시 폴더에서 실제 파일로 ─────────────────────────────
const tmpRoots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "kst-check-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
function put(root: string, rel: string, text: string): void {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
}
function exec(argv: string[], today = "2026-11-12") {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (s) => out.push(s), err: (s) => err.push(s), today });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("run --all", () => {
  it("error 가 있으면 1, --warn-only 면 0", () => {
    const root = tmp();
    put(root, "src/a.ts", "const y = d.getFullYear();\n");
    put(root, "node_modules/x/b.ts", "const y = d.getFullYear();\n");
    const r = exec(["--all", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/a.ts:1:");
    expect(r.out).not.toContain("node_modules");
    expect(exec(["--all", "--warn-only", "--root", root]).code).toBe(0);
  });

  it("warn 만 있으면 0", () => {
    const root = tmp();
    put(root, "m.sql", "select created_at::date from t;\n");
    const r = exec(["--all", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("sql-ts-cast-date");
  });

  it("--json 출력", () => {
    const root = tmp();
    put(root, "m.sql", "select current_date;\n");
    const j = JSON.parse(exec(["--all", "--json", "--root", root]).out);
    expect(j).toMatchObject({ mode: "all", errors: 1, warns: 0, scanned: 1 });
    expect(j.findings[0]).toMatchObject({ file: "m.sql", line: 1, rule: "sql-current-date" });
  });

  it("설정 exclude·allow, 미사용 allow 는 warn", () => {
    const root = tmp();
    put(root, "gen/a.ts", "const y = d.getFullYear();\n");
    put(root, "m.sql", "select current_date;\n");
    put(
      root,
      ".kst-check.json",
      JSON.stringify({
        exclude: ["gen/**"],
        allow: [
          { file: "m.sql", rule: "sql-current-date", match: "select current_date;", reason: "로그용" },
          { file: "zzz.sql", rule: "sql-current-date", match: "select 1;", reason: "안 쓰임" },
        ],
      }),
    );
    const r = exec(["--all", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("kst-allow-unused");
    expect(r.out).not.toContain("gen/a.ts");
  });

  it("만료·잘못된 allow 는 실패(1)", () => {
    const root = tmp();
    put(root, "m.sql", "select 1;\n");
    put(root, ".kst-check.json", JSON.stringify({ allow: [{ file: "m.sql", rule: "sql-current-date", match: "x", reason: "사유 있음", expires: "2026-11-11" }, { file: "m.sql" }] }));
    const r = exec(["--all", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("kst-allow-expired");
    expect(r.out).toContain("kst-allow-invalid");
  });

  it("경로 인자로 범위를 좁힌다", () => {
    const root = tmp();
    put(root, "a/x.ts", "d.getDate();\n");
    put(root, "b/y.ts", "d.getDate();\n");
    const r = exec(["--all", "--root", root, "b"]);
    expect(r.out).toContain("b/y.ts");
    expect(r.out).not.toContain("a/x.ts");
  });

  it("CRLF·BOM 파일", () => {
    const root = tmp();
    put(root, "m.sql", "﻿select 1;\r\nselect current_date;\r\n");
    const r = exec(["--all", "--root", root]);
    expect(r.out).toContain("m.sql:2:");
  });

  it("설정 JSON 오류·없는 설정·모르는 옵션은 2", () => {
    const root = tmp();
    put(root, ".kst-check.json", "{ not json");
    expect(exec(["--all", "--root", root]).code).toBe(2);
    expect(exec(["--all", "--root", root, "--config", "nope.json"]).code).toBe(2);
    expect(exec(["--all", "--root", root, "--nope"]).code).toBe(2);
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;
describe.skipIf(!hasGit)("run --changed-since (git)", () => {
  const git = (root: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  it("바뀐 줄과 새 파일만 보고한다", () => {
    const root = tmp();
    git(root, "init", "-q");
    put(root, "a.sql", "select current_date;\nselect 1;\n"); // 기존 위반(1줄)은 보고하지 않는다
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    put(root, "a.sql", "select current_date;\nselect 1;\nselect localtimestamp;\n");
    put(root, "sub/b.ts", "const a = 1;\nconst y = d.getFullYear();\n");
    put(root, "node_modules/c.ts", "d.getDate();\n");
    const r = exec(["--changed-since", "HEAD", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("a.sql:3:");
    expect(r.out).not.toContain("a.sql:1:");
    expect(r.out).toContain("sub/b.ts:2:");
    expect(r.out).not.toContain("node_modules");
  });

  it("하위 폴더를 --root 로 줘도 상대 경로가 맞다", () => {
    const root = tmp();
    git(root, "init", "-q");
    put(root, "app/a.ts", "const a = 1;\n");
    put(root, "other/z.ts", "const a = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    put(root, "app/a.ts", "const a = 1;\nd.getDate();\n");
    put(root, "other/z.ts", "const a = 1;\nd.getDate();\n");
    const r = exec(["--changed-since", "HEAD", "--root", path.join(root, "app")]);
    expect(r.out).toContain("a.ts:2:");
    expect(r.out).not.toContain("z.ts");
  });

  it("기준 브랜치가 없으면 2 와 안내", () => {
    const root = tmp();
    git(root, "init", "-q");
    put(root, "a.ts", "const a = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const r = exec(["--root", root]); // 기본 origin/main 이 없다
    expect(r.code).toBe(2);
    expect(r.err).toContain("merge-base");
  });
});

// ── 성능: 큰 SQL·긴 줄·병적 입력 ─────────────────────────────────
// 기준 시간은 이 PC 실측(아래 PERF 주석)의 여유 배수로 정했다. 느린 CI 에서도 깨지지 않게 넉넉히 잡되, 이차 시간이 되면 잡힌다.
function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

describe("성능", () => {
  const bigSql = (lines: number): string => {
    const rows: string[] = [];
    for (let i = 0; i < lines; i++) {
      switch (i % 5) {
        case 0:
          rows.push(`insert into t(id, created_at) values (${i}, now());`);
          break;
        case 1:
          rows.push(`select date_trunc('month', created_at at time zone 'Asia/Seoul') from t where id = ${i};`);
          break;
        case 2:
          rows.push(`-- 주석 줄 ${i} current_date 는 여기서 무시된다`);
          break;
        case 3:
          rows.push(`select to_char(total, '999,999'), extract(epoch from interval '1 day') from t where id = ${i};`);
          break;
        default:
          rows.push(`update t set note = 'ok ${i}' where id = ${i};`);
      }
    }
    return rows.join("\n");
  };

  it("5만 줄 SQL(위반 없음)", () => {
    const text = bigSql(50000);
    const { ms, value } = timed(() => checkSource({ file: "big.sql", text }));
    expect(value.findings).toEqual([]);
    expect(ms).toBeLessThan(PERF.sql50kMs);
  });

  it("5만 줄 SQL 에 위반이 1만 개 섞여 있어도 선형", () => {
    const lines = bigSql(50000).split("\n");
    for (let i = 0; i < 50000; i += 5) lines[i] = `select current_date, ${i};`;
    const { ms, value } = timed(() => checkSource({ file: "big.sql", text: lines.join("\n") }));
    expect(value.findings).toHaveLength(10000);
    expect(ms).toBeLessThan(PERF.sql50kBadMs);
  });

  it("5만 줄 TS", () => {
    const rows: string[] = [];
    for (let i = 0; i < 50000; i++) rows.push(i % 4 === 0 ? `const a${i} = d.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }); // x${i}` : `const b${i} = compute(${i}, "a//b");`);
    const { ms, value } = timed(() => checkSource({ file: "big.ts", text: rows.join("\n") }));
    expect(value.findings).toEqual([]);
    expect(ms).toBeLessThan(PERF.ts50kMs);
  });

  it("긴 한 줄(1MB)과 병적 입력", () => {
    const cases: Array<[string, string, string]> = [
      ["1MB 한 줄", "a.ts", `const x = "${"a".repeat(1_000_000)}";`],
      ["여는 괄호 반복", "a.ts", "toLocaleString(".repeat(20000)],
      ["닫히지 않는 date_trunc", "m.sql", "date_trunc('day', ".repeat(20000)],
      ["닫히지 않는 extract", "m.sql", "extract(hour from created_at ".repeat(20000)],
      ["숫자·하이픈 반복", "m.sql", "p_a::date + 1 )::".repeat(20000)],
      ["new Date( 반복", "a.ts", "new Date(a, ".repeat(30000)],
      ["주석 시작만 반복", "a.ts", "/*".repeat(50000)],
      ["따옴표 반복", "m.sql", "'".repeat(100000)],
    ];
    for (const [name, file, text] of cases) {
      const { ms } = timed(() => checkSource({ file, text }));
      expect(ms, name).toBeLessThan(PERF.pathologicalMs);
    }
  });

  it("입력 크기를 2배로 늘려도 시간이 4배를 넘지 않는다(이차 시간 방지)", () => {
    const small = bigSql(25000);
    const large = bigSql(50000);
    checkSource({ file: "w.sql", text: small }); // 예열
    const a = timed(() => checkSource({ file: "s.sql", text: small })).ms;
    const b = timed(() => checkSource({ file: "l.sql", text: large })).ms;
    expect(b).toBeLessThan(Math.max(a * 4, 50));
  });
});

// PERF: 이 PC(Windows 11, Node 24) 실측(2회차, ms): SQL 5만 줄 72 · 위반 1만 개 섞인 SQL 80 · TS 5만 줄 38 · 병적 입력 최대 23(닫히지 않는 date_trunc 2만 번 반복, 36만 자).
// 기준은 실측의 10배 이상 여유를 둔 값이다(느린 CI 허용). 한 줄 길이에 비례하는 이차 시간(예: 줄마다 전체 줄 복사)이 되면 수 초가 걸려 잡힌다.
const PERF = { sql50kMs: 1000, sql50kBadMs: 1000, ts50kMs: 1000, pathologicalMs: 500 };

describe("검사기 자체와 헬퍼는 규칙을 지킨다", () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const f of ["index.ts", "check.mjs"]) {
    it(`${f} 에 위반이 없다`, () => {
      const text = readFileSync(path.join(here, f), "utf8");
      const r = checkSource({ file: f, text });
      expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
    });
  }
});
